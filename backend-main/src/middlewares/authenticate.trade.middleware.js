import { timingSafeEqual } from 'node:crypto';
import { authenticateUser } from './authenticate.user.middleware.js';
import { watcherAuthToken } from '../utils/watcher-auth.js';
import { errors } from '../utils/index.js';
import { watcherTradeContext } from '../services/watcher-trade-context.js';
export async function authenticateTradeSource(req,res,next) {
 const token=req.get('X-Jarvis-Watcher');
 if(!token) return authenticateUser(req,res,(error)=>{
  if(error)return next(error);
  req.body=req.body || {};
  req.body.userId=req.user.id;
  next();
 });
 try {
  const expected=watcherAuthToken();
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||token.length!==expected.length||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return next(errors.unauthorized('Invalid watcher authentication'));
  Object.assign(req,await watcherTradeContext(req.body || {}));
  next();
 }catch(error){next(error.statusCode?error:errors.unauthorized('Watcher authentication failed'));}
}

