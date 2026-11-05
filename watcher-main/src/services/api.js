import chalk from 'chalk';
import { updateCooldown } from './cooldown.js';
import { executeWatcherTrade } from '../../../backend-main/src/services/watcher-execution.service.js';
import { captureAppEvent } from '../../../backend-main/src/whatsapp/events.js';
import { safeError } from '../../../backend-main/src/whatsapp/store.js';

async function recordDispatchFailure(payload,message,stage) {
    try {
        await captureAppEvent({userId:payload.userId,type:'trade_executed',setup:payload,executionId:payload.notificationExecutionId,
            results:(payload.accounts || []).map(account=>({account,symbol:Array.isArray(payload.tradingSymbol)?payload.tradingSymbol.join(', '):payload.tradingSymbol,success:false,
                error:`Automatic execution ${stage || 'dispatch'}: ${safeError(message)}. No filled entry confirmed; check exchange history before retrying.`}))});
    }catch{console.warn('[Watcher] Execution failure could not be recorded');}
}

export async function createOrder(payload) {
    try {
        // Foran Local Memory Update (Taake agla packet block ho jaye)
        updateCooldown(payload.id);

        const response = await executeWatcherTrade(payload);
        const results = response.body?.data;
        if(!response.ok) {
            // Per-coin failures returned by the controller are already recorded.
            // Preflight/quota/dispatch errors previously disappeared into logs.
            const message=safeError(response.body?.message || 'Automatic execution was not acknowledged');
            if(!Array.isArray(results)||!results.length)await recordDispatchFailure(payload,message,response.stage);
            console.error(chalk.red('[Watcher] Automatic execution rejected:'),message);
            return {success:false,data:results,error:message};
        }
        const allFailed = Array.isArray(results) && results.length > 0 && results.every(r => r.success === false);

        if (allFailed) {
            console.error(chalk.red('[Watcher] All entry orders were rejected'));
            return { success: false, data: results };
        }

        console.log(chalk.green('[API] Order created successfully'));
        return { success: true, data: results };
    } catch (err) {
        const message=safeError(err);
        await recordDispatchFailure(payload,message,'dispatch');
        console.error(chalk.red('[Watcher] Automatic execution error:'),message);
        return { success: false, error: message };
    }
}
