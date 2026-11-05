import express from 'express';
import { authenticateUser } from '../middlewares/index.js';
import { errors } from '../utils/index.js';
import { portfolioSnapshot } from '../services/portfolio.service.js';
const router=express.Router();
router.use(authenticateUser);
router.get('/',async(req,res,next)=>{
 try {
  const period=req.query.period || 'all',accountId=req.query.accountId || '';
  if(typeof period!=='string'||!['all','today','week','month'].includes(period)||typeof accountId!=='string')throw errors.badRequest('Choose a valid period and account');
  const data=await portfolioSnapshot(req.user.id,{period,accountId});res.json({success:true,data});
 }catch(error){next(error.message==='Account not found'?errors.notFound('Account not found'):error);}
});
export default router;
