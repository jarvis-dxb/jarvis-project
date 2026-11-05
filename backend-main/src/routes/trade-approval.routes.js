import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateUser } from '../middlewares/authenticate.user.middleware.js';
import { reviewTradeApproval, decideTradeApproval, listTradeApprovals } from '../services/trade-approval.service.js';

const router=express.Router();
const publicLimit=rateLimit({windowMs:60000,limit:40,standardHeaders:'draft-7',legacyHeaders:false});
router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});next();});
// Tokens travel in a POST body, never in server access logs or a query string.
router.post('/review',publicLimit,(req,res)=>{
 const approval=reviewTradeApproval(req.body?.token);
 if(!approval)return res.status(404).json({message:'This approval link is invalid.'});
 res.json({data:approval});
});
router.post('/decision',publicLimit,async(req,res,next)=>{
 try {
  const approval=await decideTradeApproval(req.body?.token,req.body?.decision,req.body?.reviewNonce);
  if(!approval)return res.status(404).json({message:'This approval link is invalid.'});
  res.json({data:approval});
 } catch(error) {res.status(409).json({message:error.message || 'This request cannot be approved.'});}
});
router.get('/',authenticateUser,(req,res)=>res.json({data:listTradeApprovals(req.user.id)}));
export default router;
