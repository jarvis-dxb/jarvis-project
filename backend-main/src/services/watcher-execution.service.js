import { watcherTradeContext } from './watcher-trade-context.js';
import { safeError } from '../whatsapp/store.js';

// LiteSpeed may expose only its inherited listener, not localhost:PORT. Reuse
// the manual/approved execution controller without making a self-HTTP request.
// No public endpoint or approval marker is added here.
export async function executeWatcherTrade(payload) {
 let context;
 try {
  if(!payload?.userId)throw Error('Watcher setup owner is required');
  context=await watcherTradeContext(payload,payload.userId);
 }catch(error){return {ok:false,status:error.statusCode || 403,stage:'preflight',body:{message:safeError(error)}};}
 const { marketBuy }=await import('../controllers/exchange.controller.js');
 const { checkTradeLimit }=await import('../middlewares/trade.limit.middleware.js');
 return new Promise(resolve=>{
  const req={method:'POST',path:'/order/market/buy',...context};
  let status=200,stage='quota';
  const fail=error=>resolve({ok:false,status:error?.statusCode || 500,stage,body:{message:safeError(error)}});
  const res={status(code){status=code;return this;},json(body){resolve({ok:status>=200&&status<300,status,stage,body});return this;}};
  const next=error=>{
   if(error)return fail(error);
   stage='execution';
   void Promise.resolve(marketBuy(req,res,fail)).catch(fail);
  };
  void Promise.resolve(checkTradeLimit(req,res,next)).catch(fail);
 });
}
