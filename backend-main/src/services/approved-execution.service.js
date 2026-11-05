// Use the existing quota, order, exit-rule, counter and notification code. This
// internal request cannot be created by passing fields in a browser JSON body.
export async function executeApprovedTrade(setup, approvalId, executionId) {
    const { preflightApprovedEntries } = await import('./binance-entry-isolation.js');
    const readiness = await preflightApprovedEntries(setup);
    if (!readiness.ok) return { ok: false, status: readiness.status,
        body: { status: 'error', message: readiness.message } };
    const { marketBuy } = await import('../controllers/exchange.controller.js');
    const { checkTradeLimit } = await import('../middlewares/trade.limit.middleware.js');
    return new Promise(resolve => {
        const req = { method:'POST', path:'/order/market/buy', user:{id:setup.userId},
            body:{...setup,notificationExecutionId:executionId}, approvedTrade:approvalId };
        let status=200;
        const res={ status(code){status=code;return this;}, json(body){resolve({ok:status>=200&&status<300, status, body});return this;} };
        const next=error=>error ? resolve({ok:false,status:error.statusCode || 400}) :
            void marketBuy(req,res,error=>resolve({ok:false,status:error?.statusCode || 500}));
        void checkTradeLimit(req,res,next);
    });
}
