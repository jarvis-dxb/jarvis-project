import express from 'express';
import { authenticateUser } from '../middlewares/index.js';
import { errors } from '../utils/index.js';
import { tradeCalendarSnapshot,calendarMonth } from '../services/trade-calendar.service.js';
const router=express.Router();
router.use(authenticateUser);
router.get('/',async(req,res,next)=>{
 try {
  const {month,accountId=''}=req.query;
  try {calendarMonth(month);}catch{throw errors.badRequest('Choose a valid calendar month');}
  if(typeof accountId!=='string')throw errors.badRequest('Choose a valid account');
  res.json({success:true,data:await tradeCalendarSnapshot(req.user.id,{month,accountId})});
 }catch(error){next(error.message==='Account not found'?errors.notFound('Account not found'):error);}
});
export default router;
