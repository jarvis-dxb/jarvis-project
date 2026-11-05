import express from 'express';

import { db, getDatabaseStats } from '../config/sqlite.js';
import { authenticateUser } from '../middlewares/index.js';
import { errors } from '../utils/index.js';
import { liveSnapshot, setWatcherPaused, setWatcherMode, watcherControl } from '../services/watcher-live.service.js';
import { setupTradeSummary } from '../services/setup-trade-summary.service.js';
import { validateApprovalOptions } from '../services/trade-approval-options.js';

const router = express.Router();
router.use(authenticateUser);
router.get('/setup-trades',async(req,res,next)=>{try{res.json({success:true,data:await setupTradeSummary(req.user.id)});}catch(error){next(error);}});

router.get('/status', async (req, res, next) => {
  try {
    const live = await liveSnapshot(req.user.id);

    res.json({
      success: true,
      data: {
        online: live.online,
        state: live.status,
        timestamp: live.heartbeat ? new Date(live.heartbeat) : null,
        activeSetups: live.setups.filter(s=>!s.isCompleted&&!s.watcherPaused).length,
        chartUrl: '/watcher/',
        database: getDatabaseStats().client,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/live',async(req,res,next)=>{try{res.json({success:true,data:await liveSnapshot(req.user.id)});}catch(error){next(error);}});
router.put('/monitoring',async(req,res,next)=>{
 try {
  req.body=req.body||{};
  if(typeof req.body.enabled!=='boolean')throw errors.badRequest('Choose whether all setups should be Monitoring Only');
  if(!req.body.enabled) {
   if(req.body.confirmActiveOrders!==true)throw errors.badRequest('Review the saved execution modes before enabling orders');
   const live=await liveSnapshot(req.user.id);
   if(live.setups.some(s=>!s.isCompleted&&!s.watcherPaused&&s.executionMode!=='monitoring'&&!s.accountReady))throw errors.badRequest('Connect the accounts for active Auto Execute and Confirmation setups first');
  }
  await setWatcherMode(req.user.id,req.body.enabled);
  res.json({success:true,data:await liveSnapshot(req.user.id)});
 }catch(error){next(error);}
});
router.patch('/setups/:id/mode',async(req,res,next)=>{
 try {
  req.body=req.body||{};
  const ref=db.collection('setups').doc(req.params.id),doc=await ref.get();
  if(!doc.exists||doc.data().userId!==req.user.id)throw errors.notFound('Setup not found');
  if(Object.keys(req.body).some(key=>!['executionMode','confirmActiveOrders'].includes(key)))throw errors.badRequest('Only the execution mode can be changed here');
  if(!['monitoring','auto','confirmation'].includes(req.body.executionMode))throw errors.badRequest('Choose Monitoring Only, Auto Execute or Confirmation');
  if(req.body.executionMode!=='monitoring'&&req.body.confirmActiveOrders!==true)throw errors.badRequest('Review this setup before enabling execution');
  const updates={executionMode:req.body.executionMode};
  if(req.body.executionMode==='confirmation'&&!doc.data().approvalChannels)updates.approvalChannels={whatsapp:true,email:false};
  try{validateApprovalOptions({...doc.data(),...updates});}catch(error){throw errors.badRequest(error.message);}
  // Do not touch updatedAt, cooldown, counters or any condition/trade settings.
  await ref.update(updates);
  res.json({success:true,data:await liveSnapshot(req.user.id)});
 }catch(error){next(error);}
});
router.post('/control',async(req,res,next)=>{
 try{
   const {action}=req.body || {};if(!['pause','start','monitor'].includes(action))throw errors.badRequest('Choose start, monitor or pause');
  if(action==='pause')await setWatcherPaused(req.user.id,true);
  else {
   if(action!=='monitor'&&req.body.confirmActiveOrders!==true)throw errors.badRequest('Review and confirm that active setups may place orders');
   if(action==='start') {
    const snapshot=await liveSnapshot(req.user.id);
    if(snapshot.setups.some(s=>!s.isCompleted&&!s.watcherPaused&&s.executionMode!=='monitoring'&&!s.accountReady))throw errors.badRequest('Connect and verify active setup accounts before enabling trading. You can use monitoring mode without credentials.');
   }
   const engine=await import('../../../watcher-main/src/runtime.js');
   await setWatcherPaused(req.user.id,false);
   await setWatcherMode(req.user.id,action==='monitor');
   const running=await engine.startWatcherRuntime({chartBaseUrl:'http://127.0.0.1:'+(process.env.PORT || 5000)+'/watcher',manual:true,userId:req.user.id,monitorOnly:action==='monitor'});
   if(!running){await setWatcherPaused(req.user.id,true);throw errors.badRequest('Watcher could not start. Check the connection status.');}
  }
  res.json({success:true,data:await liveSnapshot(req.user.id)});
 }catch(error){next(error);}
});
router.patch('/setups/:id',async(req,res,next)=>{
 try{
  const ref=db.collection('setups').doc(req.params.id),doc=await ref.get();
  if(!doc.exists || doc.data().userId!==req.user.id)throw errors.notFound('Setup not found');
  if(typeof req.body.paused!=='boolean')throw errors.badRequest('Invalid pause switch');
  const control=await watcherControl(req.user.id);
  if(!req.body.paused && !control.monitorOnly && doc.data().executionMode!=='monitoring' && req.body.confirmActiveOrders!==true)throw errors.badRequest('Review and confirm the saved setup rules before resuming');
  await ref.update({watcherPaused:req.body.paused});res.json({success:true,data:await liveSnapshot(req.user.id)});
 }catch(error){next(error);}
});

export default router;

