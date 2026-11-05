import express from 'express';
import { authenticateUser } from '../middlewares/index.js';
import { errors } from '../utils/index.js';
import { exportSetupBackup,previewSetupBackup,importSetupBackup } from '../services/setup-backup.service.js';
const router=express.Router();router.use(authenticateUser);
for(const [path,run] of [['export',(id,b)=>exportSetupBackup(id,b.setupIds)],['preview',(id,b)=>previewSetupBackup(id,b.backup)],['import',(id,b)=>importSetupBackup(id,b)]])router.post('/'+path,async(req,res,next)=>{try{res.json({success:true,data:await run(req.user.id,req.body || {})});}catch(error){next(errors.badRequest(error.message || 'Could not process this strategy backup'));}});
export default router;
