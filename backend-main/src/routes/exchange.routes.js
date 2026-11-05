import express from 'express';
import * as controller from '../controllers/exchange.controller.js';
import { authenticateUser, checkTradeLimit } from '../middlewares/index.js';
import { authenticateTradeSource } from '../middlewares/authenticate.trade.middleware.js';

const router = express.Router();


/**
 * =========================
 * API URL: /api/v1/platform/exchanges/rest
 * =========================
 */


router.get('/available-exchanges', controller.getAvailableExchanges);
router.get('/trading-symbols', controller.getAllTradingSymbols);
router.get('/trading-symbols/last-price/:symbol', controller.getTradingSymbolLastPrice);
router.get('/:exchangeId/account-types', controller.getExchangeAccountTypes);
router.get('/:exchangeId/networks', controller.getExchangeNetworks);

router.get('/setups', authenticateUser, controller.getSetupsByUserId);
router.post('/setups', authenticateUser, checkTradeLimit, controller.createSetup);
router.post('/setups/batch-delete', authenticateUser, controller.batchDeleteSetups);
router.patch('/setups/:setupId', authenticateUser, controller.updateSetup);
router.delete('/setups/:setupId', authenticateUser, controller.deleteSetup);

router.get('/positions', controller.getPositions);                      // get all open positions

router.post('/order/market/buy', authenticateTradeSource, checkTradeLimit, controller.marketBuy);                 // instant market buy

/**
 * 
 * {
 *   "exchanges": [binance ...],
 *   "symbol": BTCUSDT,
 *   "qty": 10,
 *   "side": long | short
 *   "action": close
 *   ... more params   
 * }
 * 
 */
router.post('/order/market/sell', controller.marketSell);               // instant market sell

/**
 * 
 * {
 *   "exchanges": [binance],
 *   "symbol": BTCUSDT,
 *   "qty": 5,
 *   "side": long | short,
 *   "action": reduce
 *   ... more params   
 * }
 * 
 */
router.post('/position/reduce', controller.reducePosition);             // partial close (i.e: 50% close, however keeping the remaining 50% active)


export default router;
