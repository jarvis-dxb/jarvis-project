import express from 'express';
import { requiredFields, authenticateUser } from '../middlewares/index.js';
import * as controller from '../controllers/user.account.controller.js';

const router = express.Router();

router.use(authenticateUser);

router.get('/', controller.getUserAccounts);
router.get('/ping', requiredFields('exchangeType', 'network', 'apiKey', 'apiSecret'), controller.pingUserAccount);
router.post('/', requiredFields('exchangeType', 'network', 'apiKey', 'apiSecret'), controller.createUserAccount);
router.put('/:id', requiredFields('exchangeType', 'network', 'apiKey', 'apiSecret'), controller.updateUserAccount);
router.patch('/:id/toggle', requiredFields('connected'), controller.toggleUserAccountConnection);
router.delete('/:id', controller.deleteUserAccount);

export default router;
