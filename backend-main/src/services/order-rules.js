import Big from 'big.js';
export const calculateTargetPrice = (side, entryPrice, leverage, margin, target, actualQuantity = null) => {
    const isLong = side.toLowerCase() === 'long';
    const entryPriceBig = new Big(entryPrice);
    const leverageBig = new Big(leverage || 1);
    
    // Use actual quantity if provided, otherwise estimate from margin/leverage
    let quantityBig;
    if (actualQuantity && new Big(actualQuantity).gt(0)) {
        quantityBig = new Big(actualQuantity);
    } else {
        const marginBig = new Big(margin || 0);
        const positionSizeBig = marginBig.times(leverageBig);
        quantityBig = positionSizeBig.div(entryPriceBig);
    }

    let targetPriceBig;

    switch (target.type) {
        case 'price':
            targetPriceBig = new Big(target.value);
            break;

        case '%':
            // ROE% to Price logic: roeFactor = (target.value / leverage) / 100
            const roeFactor = new Big(target.value).div(leverageBig).div(100);
            targetPriceBig = isLong
                ? entryPriceBig.times(new Big(1).plus(roeFactor))
                : entryPriceBig.times(new Big(1).minus(roeFactor));
            break;

        case 'pnl':
            // PnL$ to Price logic: priceChange = target.value / quantity
            const priceChange = new Big(target.value).div(quantityBig);
            targetPriceBig = isLong
                ? entryPriceBig.plus(priceChange)
                : entryPriceBig.minus(priceChange);
            break;

        default:
            targetPriceBig = entryPriceBig;
    }

    return targetPriceBig;
};

export function validateOrderConfiguration(payload) {
    const margin = Number(payload.margin), leverage = Number(payload.leverage || 1);
    if (!Number.isFinite(margin) || margin <= 0) throw new Error('Margin must be a positive number');
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('Leverage must be between 1 and 125');
    for (const role of ['TP','SL']) {
        const value = payload[role];
        if (value === '' || value === null || value === undefined) continue;
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(role+' must be a positive number');
        if (!['price','pnl','%'].includes(String(payload[role+'_mode'] || 'price').toLowerCase())) throw new Error('Invalid '+role+' mode');
    }
}
export function floorToStep(value, step) {
    return step && new Big(step).gt(0) ? new Big(value).div(step).round(0,0).times(step) : new Big(value);
}
export function targetForOrder(side, entryPrice, leverage, margin, target, quantity, tickSize, pricePrecision=2) {
    const price=calculateTargetPrice(side,entryPrice,leverage,margin,target,quantity);
    const roundUp = price.gt(entryPrice);
    const rounded=tickSize && new Big(tickSize).gt(0) ? price.div(tickSize).round(0,roundUp?3:0).times(tickSize) : price.round(pricePrecision,roundUp?3:0);
    return rounded;
}
export function validateTargets(payload, entry, quantity) {
    for(const role of ['TP','SL']) {
        if(payload[role]===undefined || payload[role]===null || payload[role]==='')continue;
        const mode=String(payload[role+'_mode'] || 'price').toLowerCase();
        const value=Number(payload[role])*(role==='SL' && mode!=='price'?-1:1);
        const target=calculateTargetPrice(payload.side,entry,payload.leverage,payload.margin,{type:mode,value},quantity);
        const shouldBeAbove=(payload.side.toLowerCase()==='long')===(role==='TP');
        if(target.lte(0) || (shouldBeAbove?!target.gt(entry):!target.lt(entry)))throw new Error('Invalid '+role+' target for '+payload.side+' entry');
    }
}