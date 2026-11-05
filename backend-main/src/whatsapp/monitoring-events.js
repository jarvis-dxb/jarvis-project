import { ownedAccounts, runtime, hash, now, symbolKey } from './store.js';
import { recordEvent, setupFields } from './events.js';
import { conditionDescription, sampleValue } from '../services/watcher-live.service.js';
import { normalizeInterval, lastClosedIndex, candleTime } from '../../../watcher-main/src/logics/market-utils.js';
import { resetPriceReferenceOnTrigger, usesResettingReference } from '../services/price-reference.service.js';

const signatureFor = setup => hash(JSON.stringify([setup.logicType,setup.triggerSymbol,normalizeInterval(setup.timeframe),setup.side,setup.indicators,setup.usdChange,setup.direction,setup.watchPrice,setup.candleRange,setup.candleColor,setup.countdown,...(usesResettingReference(setup)?[true]:[])]));

// Persist the alert gate separately from execution progress. Restarting monitoring
// must not replay the same closed candle or bypass the alert cooldown.
export async function captureMonitoringMatch(setup, datasource, {skipDelivery=false}={}) {
 if(!setup?.userId || !setup.id || setup.isCompleted || setup.watcherPaused) return [];
 const bars=datasource?.data || [],at=now();
 if(!bars.length || datasource.symbol!==setup.triggerSymbol || normalizeInterval(datasource.interval)!==normalizeInterval(setup.timeframe) || !datasource.eventTime || at-datasource.eventTime>60000 || datasource.eventTime>at+5000) return [];
 const accounts=(await ownedAccounts(setup.userId)).filter(a=>(setup.accounts || []).includes(a.id));
 const signature=signatureFor(setup);
 const stateKey='monitoring-alert:'+setup.userId+':'+setup.id,previous=runtime(stateKey);
 const candle=setup.logicType?.toLowerCase()==='candle_strike';
 const signalTime=candle?candleTime(bars[lastClosedIndex(bars)]?.time):at;
 const parts=String(setup.countdown || '').split(':').map(Number);
 const cooldown=parts.length===3&&parts.every(Number.isFinite)?Math.max(60000,(parts[0]*3600+parts[1]*60+parts[2])*1000):60000;
 if(!signalTime || ((previous.signature===signature || previous.nextSignature===signature) && (candle?signalTime<=previous.signalTime:at-previous.at<cooldown)))return [];
 const last=bars.at(-1),condition=conditionDescription(setup);
 const base={symbol:Array.isArray(setup.tradingSymbol)?setup.tradingSymbol.map(symbolKey).join(', '):symbolKey(setup.tradingSymbol || setup.triggerSymbol),triggerSymbol:symbolKey(setup.triggerSymbol),timeframe:normalizeInterval(setup.timeframe),condition:condition.rule,currentValue:sampleValue(setup,bars,bars.length-1),price:last.close,monitorOnly:true,status:'Condition matched — no order placed',summary:'Monitoring only: the saved condition matched. No order was placed.',signalCandleAt:candle?signalTime:undefined};
 // Accept the next reference's signature as the same condition for cooldown.
 // A restart or automatic rebase must not shorten the saved alert interval.
 const nextSignature=usesResettingReference(setup)?signatureFor({...setup,watchPrice:Number(last.close)}):undefined;
 const state={key:stateKey,value:{signature,nextSignature,signalTime,at}};
 if(!resetPriceReferenceOnTrigger(setup,datasource))return [];
 return (accounts.length?accounts:[null]).map(account=>recordEvent(setup.userId,'monitoring:'+setup.id+':'+signature+':'+signalTime+':'+(account?.id || 'no-account'),'monitoring_match',{...setupFields(setup,account),...base},{at,runtimeState:state,skipDelivery})).filter(Boolean);
}
