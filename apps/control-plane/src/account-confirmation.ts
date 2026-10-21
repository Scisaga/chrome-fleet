/** Website state is declared by a person; old automated observations are history. */
export function manuallyConfirmed(account: any): boolean {
  return (account.verificationSource === "manual_confirmation" || account.bindingSource === "manual_confirmation") &&
    typeof account.lastConfirmedAt === "string" && Number.isFinite(Date.parse(account.lastConfirmedAt));
}

export function accountView(account: any) {
  const { detector: _detector, lastCheckedAt, lastSuccessAt, lastVerificationSource, detectedIdentity, evidence, ...record } = account;
  const historicalVerification = account.historicalVerification || (
    (lastVerificationSource === "account_page" || lastCheckedAt) ? {
      authState: account.authState, lastCheckedAt, lastSuccessAt, evidence, detectedIdentity,
    } : undefined
  );
  return {
    ...record,
    authState: manuallyConfirmed(account) ? "manually_confirmed" as const : "bound_unconfirmed" as const,
    confirmationState: manuallyConfirmed(account) ? "confirmed" as const : "unconfirmed" as const,
    historicalVerification,
  };
}

export function confirmationRecord(account: any, principal: string, at: string) {
  return {
    ...account,
    historicalVerification: accountView(account).historicalVerification,
    authState: "manually_confirmed", verificationSource: "manual_confirmation",
    lastConfirmedAt: at, confirmedBy: principal,
  };
}
