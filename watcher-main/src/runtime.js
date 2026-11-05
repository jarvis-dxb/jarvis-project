import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { captureAppEvent } from '../../backend-main/src/whatsapp/events.js';
import { captureMonitoringMatch } from '../../backend-main/src/whatsapp/monitoring-events.js';
import { allowedSetups, publishChecks, watcherControl } from '../../backend-main/src/services/watcher-live.service.js';
import { db } from './config/database.js';
import { resetPriceReferenceOnTrigger } from '../../backend-main/src/services/price-reference.service.js';
import { createTradeApproval, pendingApproval } from '../../backend-main/src/services/trade-approval.service.js';
import { confirmationRequired } from '../../backend-main/src/services/trade-approval-options.js';
import { setupMonitoringOnly } from '../../backend-main/src/services/watcher-execution-mode.js';

import { env } from './config/env.js';
import { createOrder } from './services/api.js';
import { processSetups } from './services/process.js';
import { setOnlineStatus } from './services/online.js';
import { subscribeToSetups, getSetupsFromMemory } from './services/setups.js';
import { launchMarketFeed, dataFeed as marketDataFeed } from './services/market-feed.js';
import { lastClosedIndex, candleTime } from './logics/market-utils.js';
import { usesClosedPriceMovement } from './logics/price_movement.js';

let runtime = null;
let starting = null;
let stopping = null;
let stopped = false;
let allUsers = false;
const watchedUsers = new Set();
const monitorOnlyUsers = new Set();

export async function startWatcherRuntime({ chartBaseUrl, manual = false, userId, monitorOnly = false } = {}) {
    if (!manual && String(process.env.WATCHER_ENABLED ?? 'true').toLowerCase() === 'false') {
        await setOnlineStatus(false, { state: 'disabled' });
        return null;
    }
    if (stopping) await stopping;
    if(userId)watchedUsers.add(userId);else allUsers=true;
    if(userId) { if(monitorOnly)monitorOnlyUsers.add(userId);else monitorOnlyUsers.delete(userId); }
    if (runtime) return runtime;
    if (starting) return starting;
    starting=bootWatcher(chartBaseUrl);
    try{return await starting;}finally{starting=null;}
}

async function bootWatcher(chartBaseUrl) {
    stopped=false;

    await setOnlineStatus(false, { state: 'starting', error: null });

    const unsubscribe = subscribeToSetups();
    const incomingDataHandler = (candleData) => {
        let datasource;
        try {
            datasource = JSON.parse(candleData);
        } catch {
            return;
        }

        const latency = datasource.browserTime ? Date.now() - datasource.browserTime : null;
        setImmediate(() => {void(async()=>{
            if(stopped)return;
            const setups=await allowedSetups(getSetupsFromMemory().filter(s=>allUsers||watchedUsers.has(s.userId)));
            if(stopped)return;
            const accountSnapshot = await db.collection('userAccounts').get();
            const accounts = accountSnapshot.docs.map(d => ({id:d.id,...d.data()}));
            const ready = setups.filter(s => s.accounts?.length && s.accounts.every(id => accounts.some(a => a.id===id && a.userId===s.userId && a.ping && a.apiKey && a.apiSecret)));
            const matches = processSetups(setups.filter(s=>!pendingApproval(s)), datasource);
            void publishChecks(setups,datasource,matches).catch(()=>console.warn('[Watcher] Live view could not be updated'));
            for(const setup of matches) {
                const control=await watcherControl(setup.userId);
                if(stopped || control.paused || control.signedOut)continue;
                const effectiveControl = control.monitorOnly === undefined ? {...control,monitorOnly:monitorOnlyUsers.has(setup.userId)} : control;
                const monitoringOnly = setupMonitoringOnly(setup,effectiveControl,accounts);
                if (!monitoringOnly && !ready.some(s=>s.id===setup.id)) continue;
                if (usesClosedPriceMovement(setup)) {
                    const time = candleTime(datasource.closedBarTime);
                    const claimed = await db.collection('setups').doc(setup.id).updateIf(
                        { lastSignalCandleAt: time },
                        saved => !saved.isCompleted && !saved.watcherPaused &&
                            Number(saved.triggeredCounter || 0) < Number(saved.repeatCounter || 1) &&
                            time > (candleTime(saved.lastSignalCandleAt) || 0) &&
                            ['logicType', 'triggerSymbol', 'timeframe', 'usdChange', 'direction', 'resetReferenceOnTrigger']
                                .every(key => saved[key] === setup[key]),
                    );
                    if (!claimed) continue;
                }
                if(monitoringOnly) {
                    const events=await captureMonitoringMatch(setup,datasource,{skipDelivery:confirmationRequired(setup)}).catch(()=>{console.warn('[WhatsApp] Monitoring alert could not be recorded');return [];});
                    if(events.length&&confirmationRequired(setup))await createTradeApproval(setup,datasource,{monitorOnly:true});
                    continue;
                }
                if(!resetPriceReferenceOnTrigger(setup,datasource))continue;
                if(setup.logicType==='candle_strike') {
                    const time=candleTime(datasource.data[lastClosedIndex(datasource.data)]?.time);
                    if(time)await db.collection('setups').doc(setup.id).update({lastSignalCandleAt:time});
                }
                console.log(`${chalk.yellow(`[TRIGGERED ${latency}ms]`)} ${chalk.green(setup.triggerSymbol)} ${setup.side}`);
                const executionId = randomUUID();
                void captureAppEvent({ userId: setup.userId, type: 'trade_triggered', setup, executionId, skipDelivery:confirmationRequired(setup) })
                    .catch(() => console.warn('[WhatsApp] Trigger event could not be recorded'));
                if(confirmationRequired(setup))await createTradeApproval(setup,datasource,{executionId});
                else void createOrder({ ...setup, notificationExecutionId: executionId }).catch((error) => console.error(chalk.red('[Order Error]'), error));
            }
        })().catch(error=>console.error('[Watcher] Condition update failed:',error.message));
        });
    };

    marketDataFeed.on('incoming-data', incomingDataHandler);

    try {
        await unsubscribe.ready;
        const watchableSetups = () => allowedSetups(getSetupsFromMemory().filter(s => allUsers || watchedUsers.has(s.userId)));
        const feedRuntime = await launchMarketFeed({ getSetups: watchableSetups });
        const startedAt=Date.now();
        const heartbeatUpdate=async()=>{
            const health=feedRuntime.health();
            await db.collection('watcher').doc('status').set({online:health.healthy,state:health.healthy?'running':Date.now()-startedAt<60000&&!health.lastMarketAt?'starting':'degraded',timestamp:new Date(),feed:health,error:health.error}, {merge:true});
        };
        await heartbeatUpdate();
        const heartbeat = setInterval(() => {
            void (async () => {
                if (!(await watchableSetups()).length) await stopWatcherRuntime();
                else await heartbeatUpdate();
            })().catch(() => {});
        }, 5000);

        runtime = {
            async stop() {
                if(stopped)return;stopped=true;clearInterval(heartbeat);
                marketDataFeed.off('incoming-data', incomingDataHandler);
                unsubscribe?.();
                await feedRuntime.stop();
                await setOnlineStatus(false, { state: 'offline' });
                runtime = null;
                watchedUsers.clear();monitorOnlyUsers.clear();allUsers=false;
            },
        };
        return runtime;
    } catch (error) {
        marketDataFeed.off('incoming-data', incomingDataHandler);
        unsubscribe?.();
        await setOnlineStatus(false, { state: 'degraded', error: error.message });
        console.error(chalk.red('[Watcher] Engine failed to start:'), error.message);
        return null;
    }
}

export async function stopWatcherRuntime() {
    await starting;
    if (stopping) return stopping;
    if (!runtime) return;
    stopping = runtime.stop();
    try { await stopping; } finally { stopping = null; }
}

export async function stopWatchingUser(userId) {
    watchedUsers.delete(userId);
    monitorOnlyUsers.delete(userId);
    if (!allUsers && !watchedUsers.size) await stopWatcherRuntime();
}
