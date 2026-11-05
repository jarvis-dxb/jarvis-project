import { db } from '../config/sqlite.js';
import { errors } from '../utils/error.js';
import { watcherControl } from './watcher-live.service.js';
import { demoAutoEnabled, setupMonitoringOnly } from './watcher-execution-mode.js';
import { getUserAccountsByUserId } from './user.account.service.js';

// Shared by authenticated loopback requests and the in-process watcher. Always
// reload the saved setup; never trust stale trade parameters from a feed packet.
export async function watcherTradeContext({ id, notificationExecutionId }, expectedUserId) {
 const doc=await db.collection('setups').doc(String(id || '')).get();
 if(!doc.exists)throw errors.notFound('Watcher setup not found');
 const setup={...doc.data(),id:doc.id};
 if(expectedUserId && setup.userId!==expectedUserId)throw errors.forbidden('Watcher setup owner changed');
 const owner=await db.collection('users').doc(setup.userId).get();
 const control=await watcherControl(setup.userId);
 const accounts=await getUserAccountsByUserId(setup.userId);
 const demoAuto=control.monitorOnly && demoAutoEnabled(setup,control,accounts);
 if(!owner.exists||setup.isCompleted||setup.watcherPaused||control.paused||control.signedOut||setupMonitoringOnly(setup,control,accounts))throw errors.forbidden('Watcher trading is not active');
 return {body:{...setup,notificationExecutionId},user:{id:setup.userId,role:owner.data().role,email:owner.data().email},demoAutoExecution:!!demoAuto};
}
