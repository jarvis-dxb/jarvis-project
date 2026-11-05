// Selected Demo confirmations can execute after Yes while other strategies
// stay in monitoring mode. Temporary one-use tests remain separate.
function demoTradingEligible(setup, control, accounts) {
    return control?.monitorOnly === true && !control.forceMonitoringOnly && !control.paused
        && !setup.isCompleted && !setup.watcherPaused
        && !!setup.accounts?.length && setup.accounts.every(id => accounts.some(account =>
            account.id === id && account.userId === setup.userId && account.network === 'testnet'
            && account.exchangeType === 'binance' && account.accountType === 'futures'
            && account.ping && account.apiKey && account.apiSecret));
}

const demoApprovalEligible = (setup, control, accounts) => setup.executionMode === 'confirmation'
    && demoTradingEligible(setup, control, accounts);

export function demoAutoEnabled(setup, control, accounts) {
    return setup.executionMode === 'auto' && demoTradingEligible(setup, control, accounts)
        && Array.isArray(control.demoAutoSetupIds) && control.demoAutoSetupIds.includes(setup.id);
}

export function demoApprovalTestEnabled(setup, control, accounts, now = Date.now()) {
    const scope = control?.demoApprovalTest;
    return demoApprovalEligible(setup, control, accounts)
        && scope?.setupId === setup.id && !scope.usedApprovalId
        && Number.isFinite(scope.expiresAt) && scope.expiresAt > now;
}

export function demoConfirmationEnabled(setup, control, accounts) {
    return demoApprovalEligible(setup, control, accounts)
        && Array.isArray(control.demoConfirmationSetupIds)
        && control.demoConfirmationSetupIds.includes(setup.id);
}

export function demoApprovalExecutionEnabled(setup, control, accounts) {
    return demoAutoEnabled(setup, control, accounts)
        || demoConfirmationEnabled(setup, control, accounts) || demoApprovalTestEnabled(setup, control, accounts);
}

export function setupMonitoringOnly(setup, control, accounts) {
    return setup?.executionMode === 'monitoring' || control?.forceMonitoringOnly === true
        || !!control?.monitorOnly && !demoApprovalExecutionEnabled(setup, control, accounts);
}
