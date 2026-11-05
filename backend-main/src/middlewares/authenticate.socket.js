import { verifyToken } from '../utils/jwt.js';
import { db } from '../config/sqlite.js';
export async function authenticateSocket(socket,next) {
 try {
  const claims=verifyToken(socket.handshake.auth?.token);
  if(!claims?.id)throw Error('Authentication required');
  const owner=await db.collection('users').doc(String(claims.id)).get();
  if(!owner.exists)throw Error('Authentication required');
  // Never trust a client-supplied userId to choose private rooms or data.
  socket.userId=String(claims.id);
  next();
 }catch{next(Error('Authentication required'));}
}
