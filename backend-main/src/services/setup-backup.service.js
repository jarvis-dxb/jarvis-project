import { randomUUID, createHash } from 'node:crypto';
import { db } from '../config/sqlite.js';
import { waDb, ownedAccounts, ownedSetups } from '../whatsapp/store.js';
import { validateApprovalOptions } from './trade-approval-options.js';
import { validateOrderConfiguration } from './order-rules.js';

const FORMAT='jarvis-strategy-backup',MAX_BYTES=80*1024,MAX_SETUPS=50;
const fields=['setupName','triggerSymbol','timeframe','tradingSymbol','side','margin','leverage','SL','SL_mode','TP','TP_mode','logicType','indicators','resetReferenceOnTrigger','executionMode','approvalChannels','approvalExpiryMinutes','approvalMaxPriceDeviationPct','countdown','repeatCounter','usdChange','direction','watchPrice','candleRange','candleColor'];
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const fail=message=>{throw Error(message);};
const text=(v,label,max=160)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f]/.test(v))fail('Invalid '+label);};
const numeric=(v,label,min=0,max=1e15,integer=false)=>{if(!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max||integer&&!Number.isInteger(Number(v)))fail('Invalid '+label);};
const only=(value,allowed,label)=>{if(!plain(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Invalid '+label+' fields');};
const symbol=v=>{text(v,'coin symbol',80);if(!/^(?:[A-Z0-9_]+:)?[A-Z0-9_]+(?:\/[A-Z0-9]+)?(?::[A-Z0-9]+)?(?:\.[PS])?$/.test(v))fail('Invalid coin symbol');};
function validateSettings(s) {
 only(s,fields,'strategy');text(s.setupName,'setup name',160);symbol(s.triggerSymbol);
 const frames=['1','3','5','15','30','60','120','240','360','480','720','1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','1w'];
 if(!frames.includes(String(s.timeframe).toLowerCase()))fail('Unsupported strategy timeframe');
 if(!['rsi','volume','candle_strike','price_movement'].includes(s.logicType))fail('Unsupported strategy logic');
 const coins=typeof s.tradingSymbol==='string'?[s.tradingSymbol]:s.tradingSymbol;
 if(!Array.isArray(coins)||coins.length<1||coins.length>100||new Set(coins).size!==coins.length)fail('Choose 1–100 unique trading coins');coins.forEach(symbol);
 if(!['long','short'].includes(s.side))fail('Choose long or short');
 validateOrderConfiguration(s);numeric(s.repeatCounter,'repeat limit',1,50,true);
 if(typeof s.countdown!=='string'||!/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(s.countdown))fail('Invalid repeat cooldown');
 if(s.resetReferenceOnTrigger!==undefined&&typeof s.resetReferenceOnTrigger!=='boolean')fail('Invalid reference reset option');
 if(!['monitoring','auto','confirmation'].includes(s.executionMode))fail('Choose a saved execution mode');validateApprovalOptions(s);
 if(s.indicators!==undefined){if(!plain(s.indicators)||Object.keys(s.indicators).length>10)fail('Invalid indicators');for(const [k,v]of Object.entries(s.indicators)){text(k,'indicator',100);if(!/volume|relative strength index|rsi/i.test(k))fail('Unsupported indicator');numeric(v,'indicator threshold');}}
 if(s.logicType==='rsi')numeric(s.indicators?.['Relative Strength Index (14)'],'RSI threshold',0,100);
 if(s.logicType==='volume'){const values=Object.entries(s.indicators || {}).filter(([k])=>/volume/i.test(k));if(values.length!==1)fail('One volume threshold is required');numeric(values[0][1],'volume threshold');}
 if(['price_movement','volume'].includes(s.logicType)&&!['up','down'].includes(s.direction))fail('Choose up or down');
 if(s.logicType==='price_movement'){numeric(s.usdChange,'USD movement',0.00000001);numeric(s.watchPrice,'saved reference price',0.00000001);}
 if(s.logicType==='candle_strike'){numeric(s.candleRange,'candle count',1,5000,true);if(!['red','green'].includes(String(s.candleColor).toLowerCase()))fail('Choose red or green candles');}
 return s;
}
function portableSettings(saved){const s={};for(const f of fields)if(saved[f]!==undefined)s[f]=structuredClone(saved[f]);s.executionMode ||= 'auto';s.repeatCounter ??= 1;s.countdown ||= '00:00:00';s.indicators ||= {};return validateSettings(s);}

export function validateBackup(backup) {
 if(Buffer.byteLength(JSON.stringify(backup) || '')>MAX_BYTES)fail('Backup is too large (maximum 80 KB)');
 only(backup,['format','version','exportedAt','accounts','setups'],'backup');
 if(backup.format!==FORMAT||backup.version!==1)fail('Choose a Jarvis strategy backup (version 1)');
 if(typeof backup.exportedAt!=='string'||!Number.isFinite(Date.parse(backup.exportedAt)))fail('Invalid backup date');
 if(!Array.isArray(backup.accounts)||backup.accounts.length<1||backup.accounts.length>50)fail('Invalid backup accounts');
 const accounts=new Set();for(const a of backup.accounts){only(a,['key','name','exchange','network','accountType'],'account');if(!/^a[1-9]\d*$/.test(a.key)||accounts.has(a.key))fail('Invalid or duplicate account reference');accounts.add(a.key);text(a.name,'account name');if(!['binance','bybit'].includes(a.exchange)||!['mainnet','testnet'].includes(a.network)||a.accountType!=='futures')fail('Unsupported account type or network');}
 if(!Array.isArray(backup.setups)||!backup.setups.length||backup.setups.length>MAX_SETUPS)fail('Choose 1–50 strategies');
 const keys=new Set();for(const row of backup.setups){only(row,['key','settings','accountKeys'],'setup');if(!/^s[1-9]\d*$/.test(row.key)||keys.has(row.key))fail('Invalid or duplicate strategy reference');keys.add(row.key);validateSettings(row.settings);if(!Array.isArray(row.accountKeys)||!row.accountKeys.length||row.accountKeys.length>20||new Set(row.accountKeys).size!==row.accountKeys.length||row.accountKeys.some(k=>!accounts.has(k)))fail('Invalid strategy account references');}
 return structuredClone(backup);
}

export async function exportSetupBackup(userId,setupIds) {
 const [setups,accounts]=await Promise.all([ownedSetups(userId),ownedAccounts(userId)]);
 if(!Array.isArray(setupIds)||!setupIds.length||setupIds.length>MAX_SETUPS||setupIds.some(id=>typeof id!=='string')||new Set(setupIds).size!==setupIds.length)fail('Select 1–50 strategies to export');
 const selected=setupIds.map(id=>setups.find(s=>s.id===id));if(selected.some(s=>!s))fail('One or more selected setups are unavailable');
 const map=new Map(),safeAccounts=[];
 for(const s of selected)for(const id of s.accounts || [])if(!map.has(id)){const a=accounts.find(a=>a.id===id);if(!a)fail('A linked account is missing. Edit the setup account before exporting.');const key='a'+(map.size+1);map.set(id,key);safeAccounts.push({key,name:a.name,exchange:a.exchangeType,network:a.network,accountType:a.accountType || 'futures'});}
 return validateBackup({format:FORMAT,version:1,exportedAt:new Date().toISOString(),accounts:safeAccounts,setups:selected.map((s,i)=>({key:'s'+(i+1),settings:portableSettings(s),accountKeys:s.accounts.map(id=>map.get(id))}))});
}

export async function previewSetupBackup(userId,backup) {
 const safe=validateBackup(backup),accounts=await ownedAccounts(userId);
 return {backup:safe,accountOptions:accounts.filter(a=>['binance','bybit'].includes(a.exchangeType)&&(a.accountType || 'futures')==='futures').map(a=>({id:a.id,name:a.name,exchange:a.exchangeType,network:a.network})),message:'Imported strategies are new paused copies. Saved rules and execution modes are preserved; execution counters restart at zero. Review the account, mode and saved reference price before resuming.'};
}

const locks=new Map();
export async function importSetupBackup(userId,payload) {
 const before=locks.get(userId)||Promise.resolve();let release;const hold=new Promise(r=>release=r),tail=before.then(()=>hold);locks.set(userId,tail);await before;
 try{return await importUnlocked(userId,payload);}finally{release();if(locks.get(userId)===tail)locks.delete(userId);}
}
async function importUnlocked(userId,{backup,selectedKeys,accountMap,requestId}={}) {
 const safe=validateBackup(backup);
 if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))fail('A valid import request ID is required');
 if(!Array.isArray(selectedKeys)||!selectedKeys.length||new Set(selectedKeys).size!==selectedKeys.length||selectedKeys.some(k=>!safe.setups.some(s=>s.key===k)))fail('Select valid strategies to import');
 const selected=safe.setups.filter(s=>selectedKeys.includes(s.key)),required=new Set(selected.flatMap(s=>s.accountKeys));
 if(!plain(accountMap)||Object.keys(accountMap).some(k=>!safe.accounts.some(a=>a.key===k)))fail('Invalid account mapping');
 const digest=createHash('sha256').update(JSON.stringify({safe,selectedKeys:[...selectedKeys].sort(),accountMap:Object.fromEntries(Object.entries(accountMap).sort())})).digest('hex');
 const receiptId=createHash('sha256').update(userId+':'+requestId).digest('hex'),receiptRef=db.collection('setupBackupImports').doc(receiptId),receipt=await receiptRef.get();
 if(receipt.exists){const saved=receipt.data();if(saved.digest!==digest)fail('This import request was already used for another selection');return {...saved.result,replayed:true};}
 const accounts=await ownedAccounts(userId);
 for(const k of required){const source=safe.accounts.find(a=>a.key===k),target=accounts.find(a=>a.id===accountMap[k]);if(!target)fail('Choose one of your accounts for '+source.name);if(target.exchangeType!==source.exchange||(target.accountType || 'futures')!=='futures')fail('Map '+source.name+' to a Futures account on the same exchange');}
 for(const row of selected)if(new Set(row.accountKeys.map(k=>accountMap[k])).size!==row.accountKeys.length)fail('Two source accounts cannot map to the same account in one strategy');
 const existing=await ownedSetups(userId),names=new Set(existing.map(s=>s.setupName));
 const batch=db.batch(),created=[],at=new Date();
 for(const row of selected){let base=row.settings.setupName.slice(0,135)+' (Imported)',name=base,n=2;while(names.has(name))name=base+' '+n++;names.add(name);const id=randomUUID();const settings=structuredClone(row.settings);const value={...settings,setupName:name,accounts:row.accountKeys.map(k=>accountMap[k]),userId,watcherPaused:true,isCompleted:false,triggeredCounter:0,createdAt:at,updatedAt:at};batch.set(db.collection('setups').doc(id),value);created.push({id,setupName:name,executionMode:settings.executionMode,watcherPaused:true});}
 const result={created,count:created.length,paused:true};batch.set(receiptRef,{userId,digest,result,createdAt:at});
 // No await between this fresh quota check and the synchronous batch transaction.
 const user=JSON.parse(waDb.prepare("SELECT data_json FROM documents WHERE collection_name='users' AND document_id=?").get(userId)?.data_json || '{}');
 if(!['user','admin'].includes(user.role))fail('User is not allowed to import strategies');
 const limit=Number.parseInt(user.limitTrades || 10,10),count=waDb.prepare("SELECT COUNT(*) AS count FROM documents WHERE collection_name='setups' AND json_extract(data_json,'$.userId')=?").get(userId).count;
 if(count+created.length>limit)fail('Setup limit reached. Import fewer strategies or remove an unused setup.');
 await batch.commit();return result;
}
