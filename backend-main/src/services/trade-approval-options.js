export const confirmationRequired = setup => setup?.executionMode === 'confirmation';
export function validateApprovalOptions(values) {
    if (values.executionMode !== undefined && !['monitoring', 'auto', 'confirmation'].includes(values.executionMode)) throw Error('Choose Monitoring Only, Auto Execute or Confirmation');
    if (values.approvalExpiryMinutes !== undefined && ![2, 5, 10, 15].includes(Number(values.approvalExpiryMinutes))) throw Error('Approval expiry must be 2, 5, 10 or 15 minutes');
    if (values.approvalMaxPriceDeviationPct !== undefined && (!Number.isFinite(Number(values.approvalMaxPriceDeviationPct)) || Number(values.approvalMaxPriceDeviationPct) < 0.1 || Number(values.approvalMaxPriceDeviationPct) > 10)) throw Error('Approval price tolerance must be between 0.1% and 10%');
    if (values.approvalChannels !== undefined && (!values.approvalChannels || typeof values.approvalChannels !== 'object' || Array.isArray(values.approvalChannels) || Object.entries(values.approvalChannels).some(([k,v]) => !['whatsapp','email'].includes(k) || typeof v !== 'boolean'))) throw Error('Invalid approval notification channels');
    if (confirmationRequired(values) && values.approvalChannels && !values.approvalChannels.whatsapp && !values.approvalChannels.email) throw Error('Select WhatsApp, email, or both for confirmation');
}
