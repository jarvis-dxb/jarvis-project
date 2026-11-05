import { ownedAccounts,ownedSetups,settings,waDb,runtime,saveRuntime,now,parse,safeError,symbolKey } from './store.js';
import { recordEvent,findOrder } from './events.js';
import { brokerManager } from '../brokers/index.js';
import { db } from '../config/sqlite.js';
import Big from 'big.js';
import { positionEntryReference } from './trade-result.js';
const clients=new Map();
const clean=symbol=>String(symbol||'').replace(/^[A-Z]+:/,'').replace(/\.P$/,'');
function normalizeSymbol(value) { const s=clean(value);return s.includes('/')?s:s.endsWith('USDT')?s.slice(0,-4)+'/USDT:USDT':s; }
export function ingestFill(userId,account,fill) {
 const timestamp=Number(fill.timestamp || fill.info?.time || fill.info?.execTime || now());
 if(timestamp<(settings(userId).trackingSince || 0))return;
 const orderId=String(fill.order || fill.info?.orderId || fill.info?.i || '');
 const reference=findOrder(account.id,orderId,fill.symbol || fill.info?.symbol);
 if(!reference && settings(userId).scope!=='all')return;
 const tradeId=String(fill.id || fill.info?.execId || fill.info?.t || '');
 if(!tradeId)return;
 const info=fill.info || {},pnl=info.realizedPnl ?? info.rp ?? null;
 const data={...reference,accountId:account.id,account:account.name,network:account.network,exchange:account.exchangeType,symbol:fill.symbol || info.symbol,side:reference?.side || (info.positionSide && info.positionSide!=='BOTH'?info.positionSide.toLowerCase():fill.side || info.side),fillSide:String(fill.side || info.side || '').toLowerCase() || undefined,positionSide:info.positionSide,price:fill.price ?? info.price,quantity:fill.amount ?? info.qty,orderId,fillId:tradeId,appOrder:!!reference,pnl,pnlSource:pnl===null?'unavailable':'fill',currency:pnl===null?null:'USDT',fees:fill.fee?.cost ?? info.commission,feeCurrency:fill.fee?.currency ?? info.commissionAsset,status:'filled'};
 recordEvent(userId,'fill:'+account.id+':'+symbolKey(data.symbol)+':'+tradeId,'trade_filled',data,{source:'exchange',at:Number(fill.timestamp || info.time || info.execTime || now())});
 if(pnl!==null && (Number(pnl)!==0 || ['tp','sl'].includes(reference?.role)))recordEvent(userId,'fill-pnl:'+account.id+':'+symbolKey(data.symbol)+':'+tradeId,'pnl_updated',data,{source:'exchange',at:timestamp});
 if(reference?.role==='tp'||reference?.role==='sl')recordEvent(userId,'hit:'+account.id+':'+symbolKey(data.symbol)+':'+orderId,reference.role==='tp'?'take_profit_hit':'stop_loss_hit',data,{source:'exchange',at:Number(fill.timestamp || now())});
}
export function ingestOrder(userId,account,order) {
 const reference=findOrder(account.id,order.id,order.symbol);if(!reference&&settings(userId).scope!=='all')return;
 const data={...reference,accountId:account.id,account:account.name,network:account.network,exchange:account.exchangeType,symbol:order.symbol,side:reference?.side || order.side,price:order.average || order.price,quantity:order.filled,orderId:String(order.id),appOrder:!!reference,status:order.status};
 if(order.status==='canceled')recordEvent(userId,'cancel:'+account.id+':'+symbolKey(data.symbol)+':'+order.id,'order_cancelled',data,{source:'exchange'});
 if(order.status==='rejected')recordEvent(userId,'reject:'+account.id+':'+symbolKey(data.symbol)+':'+order.id,'order_failed',{...data,error:'Exchange rejected this order'},{source:'exchange'});
 if(order.status==='closed'&&Number(order.filled)>0&&(reference?.role==='tp'||reference?.role==='sl'))recordEvent(userId,'hit:'+account.id+':'+symbolKey(data.symbol)+':'+order.id,reference.role==='tp'?'take_profit_hit':'stop_loss_hit',data,{source:'exchange'});
}
export function ingestPositions(userId,account,positions,{complete=true}={}) {
 const key='positions:'+userId,all=runtime(key),baseline=runtime('position-baseline:'+account.id);
 if(complete) {
  const incoming=new Set(positions.map(p=>account.id+':'+p.symbol+':'+(p.side || 'both')));
  positions=[...positions,...Object.entries(all).filter(([name,p])=>name.startsWith(account.id+':')&&Number(p.contracts)>0&&!incoming.has(name)).map(([,p])=>({...p,contracts:0}))];
 }
 for(const p of positions) {
  const name=account.id+':'+p.symbol+':'+(p.side || 'both'),old=all[name],amount=Math.abs(Number(p.contracts ?? p.info?.positionAmt ?? 0));
  const current={contracts:amount,symbol:p.symbol,side:p.side,entryPrice:p.entryPrice,markPrice:p.markPrice,
   liquidationPrice:p.liquidationPrice,initialMargin:p.initialMargin,leverage:p.leverage,marginMode:p.marginMode,
   unrealizedPnl:p.unrealizedPnl,updatedAt:now(),accountId:account.id};
  if(baseline.ready && old && Number(old.contracts)>amount) {
   const reference=positionEntryReference(userId,account.id,p.symbol,old,now());
   if(reference || settings(userId).scope==='all')recordEvent(userId,'position:'+name+':'+old.updatedAt+':'+amount,amount===0?'trade_closed':'position_reduced',{...reference,accountId:account.id,account:account.name,exchange:account.exchangeType,network:account.network,symbol:p.symbol,side:p.side,quantity:Number(old.contracts)-amount,remainingQuantity:amount,entryPrice:old.entryPrice,observedMarkPrice:p.markPrice || old.markPrice,appOrder:!!reference,pnl:null,summary:amount===0?'Position is flat. Waiting for exchange fills to confirm the realized result.':'Remaining contracts: '+amount},{source:'exchange'});
  }
  // A position can keep the same quantity while its entry price and PnL change.
  all[name]=current;
 }
 saveRuntime(key,all);saveRuntime('position-baseline:'+account.id,{ready:true});
 if(complete)saveRuntime('position-snapshot:'+account.id,{at:now(),complete:true});
}
async function positionsTick(client) {
 let positions;
 if(client.account.exchangeType==='bybit') {
  const rows=[];let cursor;
  for(let page=0;page<20;page++) {
   const response=await client.exchange.privateGetV5PositionList({category:'linear',settleCoin:'USDT',limit:200,...(cursor?{cursor}:{})});
   rows.push(...(response.result?.list || []));cursor=response.result?.nextPageCursor;
   if(!cursor)break;if(page===19)throw Error('Position snapshot has more pages; not using an incomplete snapshot');
  }
  positions=rows.map(p=>({symbol:normalizeSymbol(p.symbol),side:p.side==='Sell'?'short':p.side==='Buy'?'long':Number(p.positionIdx)===2?'short':'long',contracts:p.size,entryPrice:p.avgPrice,markPrice:p.markPrice,liquidationPrice:p.liqPrice,initialMargin:p.positionIM,leverage:p.leverage,unrealizedPnl:p.unrealisedPnl}));
 } else {
  const rows=await client.exchange.fapiPrivateV3GetPositionRisk();
  // Read account configuration occasionally; never infer leverage from a setup
  // because manually opened trades can use different exchange settings.
  if(typeof client.exchange.fapiPrivateGetSymbolConfig==='function'&&now()-(client.configAttemptAt || 0)>=60000) {
   client.configAttemptAt=now();
   try {
    const configs=await client.exchange.fapiPrivateGetSymbolConfig();
    client.symbolConfigs=Object.fromEntries(configs.map(row=>[row.symbol,row]));client.configAt=now();
   }catch { /* Optional metadata must not interrupt current positions/PnL. */ }
  }
  const configs=now()-(client.configAt || 0)<120000?client.symbolConfigs || {}:{};
  positions=rows.map(p=>({symbol:normalizeSymbol(p.symbol),side:p.positionSide==='SHORT'||(p.positionSide==='BOTH'&&Number(p.positionAmt)<0)?'short':'long',contracts:Math.abs(Number(p.positionAmt)),entryPrice:p.entryPrice,markPrice:p.markPrice,liquidationPrice:p.liquidationPrice,initialMargin:p.positionInitialMargin,leverage:configs[p.symbol]?.leverage,marginMode:configs[p.symbol]?.marginType?.toLowerCase(),unrealizedPnl:p.unRealizedProfit}));
 }
 if(client.stopped)return [];
 ingestPositions(client.userId,client.account,positions);
 return positions;
}
export async function fillBackfill(client,positions) {
 const s=settings(client.userId),key='fill-cursor:'+client.account.id,last=runtime(key);
 // Recover from the saved cursor in bounded windows; do not silently skip an outage.
 const cursorAt=last.at || s.trackingSince || now(),windowMs=last.windowMs || 3600000;
 const start=Math.max(s.trackingSince || 0,cursorAt-1000),end=Math.min(now(),cursorAt+windowMs);
 const incomplete=()=>{saveRuntime(key,{...last,at:cursorAt,windowMs:Math.max(1000,Math.floor(windowMs/2))});return Error('Catch-up window has more pages; retrying a smaller window without skipping trades');};
 if(client.account.exchangeType==='bybit') {
  let cursor;
  for(let page=0;page<20;page++) {
   const response=await client.exchange.privateGetV5ExecutionList({category:'linear',startTime:start,endTime:end,limit:100,...(cursor?{cursor}:{})});
   for(const t of response.result?.list || [])if(t.execType==='Trade')ingestFill(client.userId,client.account,{id:t.execId,order:t.orderId,symbol:normalizeSymbol(t.symbol),timestamp:Number(t.execTime),side:t.side.toLowerCase(),price:t.execPrice,amount:t.execQty,fee:{cost:t.execFee,currency:'USDT'},info:t});
   cursor=response.result?.nextPageCursor;if(!cursor)break;
   if(page===19)throw incomplete();
  }
  let pnlCursor;
  for(let page=0;page<20;page++) {
   const response=await client.exchange.privateGetV5PositionClosedPnl({category:'linear',startTime:start,endTime:end,limit:100,...(pnlCursor?{cursor:pnlCursor}:{})});
   for(const row of response.result?.list || []) {
    const reference=findOrder(client.account.id,row.orderId,row.symbol);
    if(reference || s.scope==='all') {
     const pnlKey='pnl:'+client.account.id+':'+symbolKey(row.symbol)+':'+row.orderId,old=runtime(pnlKey);
     if(Number(old.updatedAt || 0)>=Number(row.updatedTime))continue;
     const delta=new Big(row.closedPnl).minus(old.value || 0).toFixed();
     recordEvent(client.userId,pnlKey+':'+row.updatedTime,'pnl_updated',{...reference,accountId:client.account.id,account:client.account.name,network:client.account.network,symbol:normalizeSymbol(row.symbol),orderId:row.orderId,pnl:row.closedPnl,deltaPnl:delta,currency:'USDT',pnlSource:'closed_net',pnlIncludesFees:true,appOrder:!!reference},{source:'exchange',at:Number(row.updatedTime),runtimeState:{key:pnlKey,value:{value:row.closedPnl,updatedAt:row.updatedTime}}});
    }
   }
   pnlCursor=response.result?.nextPageCursor;if(!pnlCursor)break;if(page===19)throw incomplete();
  }
  saveRuntime(key,{at:end});
 } else {
  const setups=await ownedSetups(client.userId);
  const symbols=new Set([...positions.map(p=>p.symbol),...setups.filter(x=>(x.accounts || []).includes(client.account.id)).flatMap(x=>Array.isArray(x.tradingSymbol)?x.tradingSymbol:[x.tradingSymbol]),...waDb.prepare('SELECT data_json FROM jarvis_trade_order_refs WHERE account_id=?').all(client.account.id).map(r=>parse(r.data_json).symbol)].filter(Boolean).map(normalizeSymbol));
  // Income records discover manually opened/closed symbols between position polls.
  if(s.scope==='all') {
   for(let page=1;page<=20;page++) {
    const incomes=await client.exchange.fapiPrivateGetIncome({startTime:start,endTime:end,limit:1000,page});
    for(const row of incomes)if(row.symbol)symbols.add(normalizeSymbol(row.symbol));
    if(incomes.length<1000)break;if(page===20)throw incomplete();
   }
  }
  for(const symbol of symbols) {
   let fromId;for(let page=0;page<20;page++) {
    const rows=await client.exchange.fapiPrivateGetUserTrades({symbol:clean(symbol).replace('/USDT:USDT','USDT'),limit:1000,...(fromId?{fromId}:{startTime:start,endTime:end})});
    for(const t of rows)if(Number(t.time)>=start&&Number(t.time)<=end)ingestFill(client.userId,client.account,{id:String(t.id),order:String(t.orderId),timestamp:Number(t.time),symbol,side:t.side.toLowerCase(),price:t.price,amount:t.qty,fee:{cost:t.commission,currency:t.commissionAsset},info:t});
    if(rows.length<1000||Number(rows[rows.length-1].time)>end)break;
    fromId=String(BigInt(rows[rows.length-1].id)+1n);if(page===19)throw incomplete();
   }
  }
  saveRuntime(key,{at:end});
 }
}
function updateMonitor(userId,account,status,error=null,channel='positions') {
 const data=runtime('monitor:'+userId),old=data[account.id];
 // Optional streams and history recovery must not overwrite position health.
 const positionStatus=channel==='positions'?status:old?.positionsStatus || old?.status || 'connecting';
 const positionError=channel==='positions'?error:old?.positionsError || null;
 data[account.id]={...old,account:account.name,status:positionStatus,error:positionError,
  updatedAt:channel==='positions'?now():old?.updatedAt || null,
  [channel+'Status']:status,[channel+'Error']:error,[channel+'UpdatedAt']:now()};
 saveRuntime('monitor:'+userId,data);
 if(old?.status && old.status!==positionStatus)recordEvent(userId,'monitor:'+account.id+':'+old.updatedAt+':'+positionStatus,'exchange_status',{accountId:account.id,account:account.name,network:account.network,status:positionStatus,summary:positionStatus==='online'?'Trade tracking is connected':'Trade tracking is reconnecting; catch-up will run after recovery',error:positionError},{source:'system'});
}
function startClient(userId,account) {
 const exchange=brokerManager._getExchangeInstance(account.exchangeType,{apiKey:account.apiKey,apiSecret:account.apiSecret},account.network==='testnet');
 exchange.enableRateLimit=true;exchange.timeout=15000;
 const client={userId,account,exchange,stopped:false,ticking:false,backfilling:false,historyAt:0};clients.set(account.id,client);
 for(const [method,consume]of [['watchMyTrades',fill=>ingestFill(userId,account,fill)],['watchOrders',order=>ingestOrder(userId,account,order)]]) {
  // CCXT's REST classes also expose throwing stubs for unsupported watch methods.
  if(![true,'emulated'].includes(exchange.has?.[method])||typeof exchange[method]!=='function')continue;
  void(async()=>{while(!client.stopped) {
   try { const rows=await exchange[method]();if(client.stopped)break;for(const row of rows)consume(row);updateMonitor(userId,account,'online',null,method); }
   catch(error) {
    if(client.stopped)break;
    const unsupported=error?.name==='NotSupported'||/not supported/i.test(error?.message || '');
    updateMonitor(userId,account,unsupported?'unsupported':'reconnecting',safeError(error),method);
    if(unsupported)break;
    await new Promise(r=>setTimeout(r,10000));
   }
  }})();
 }
 return client;
}
export async function monitorTick() {
 const users=waDb.prepare('SELECT user_id FROM jarvis_wa_settings').all().map(r=>r.user_id),wanted=new Set();
 for(const user of users) {
  const s=settings(user);if(!s.enabled&&!s.reports.enabled)continue;
  for(const account of await ownedAccounts(user)) {
   if(!account.apiKey||!account.apiSecret||!['binance','bybit'].includes(account.exchangeType)||(s.accountIds.length&&!s.accountIds.includes(account.id)))continue;
   wanted.add(account.id);const client=clients.get(account.id)||startClient(user,account);
   if(client.account.apiKey!==account.apiKey||client.account.apiSecret!==account.apiSecret||client.account.network!==account.network){client.stopped=true;await client.exchange.close();clients.delete(account.id);continue;}
   if(client.ticking)continue;client.ticking=true;
   void positionsTick(client).then(positions=>{
    if(client.stopped)return;
    updateMonitor(user,account,'online');
    // Recover history separately, at the existing 30-second cadence. A slow or
    // failed recovery cannot freeze current position/PnL polling.
    if(!client.backfilling&&now()-client.historyAt>=30000) {
     client.backfilling=true;client.historyAt=now();
     void fillBackfill(client,positions)
      .then(()=>{if(!client.stopped)updateMonitor(user,account,'online',null,'history');})
      .catch(error=>{if(!client.stopped)updateMonitor(user,account,'reconnecting',safeError(error),'history');})
      .finally(()=>{client.backfilling=false;});
    }
   }).catch(error=>{if(!client.stopped)updateMonitor(user,account,'reconnecting',safeError(error));}).finally(()=>{client.ticking=false;});
  }
 }
 for(const [key,client]of clients)if(!wanted.has(key)){client.stopped=true;await client.exchange.close();clients.delete(key);updateMonitor(client.userId,client.account,'paused');}
 const snapshot=await db.collection('watcher').doc('status').get(),state=snapshot.data()||{},previous=runtime('watcher');saveRuntime('watcher',{online:!!state.online,state:state.state,timestamp:state.timestamp});
 if(previous.online!==undefined&&previous.online!==!!state.online)for(const user of users)recordEvent(user,'watcher:'+String(state.timestamp)+':'+!!state.online,'watcher_status',{status:state.online?'online':'offline',summary:state.online?'Watcher is monitoring your conditions':'Watcher is offline. Automatic conditions are not being monitored.'},{source:'system'});
}
export async function stopMonitors(){for(const c of clients.values()){c.stopped=true;await c.exchange.close().catch(()=>{});}clients.clear();}

