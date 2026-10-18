import type { GoogleBinding, GoogleLoginStatus } from "./api";

export function googleBindingLabel(binding?: GoogleBinding) {
  if (!binding) return "未绑定 Google 账号";
  return binding.confirmationState === "confirmed" ? "已人工确认登录" : "已绑定，待人工确认";
}

export function bindingProgress(binding: GoogleBinding): GoogleLoginStatus {
  return {
    status: binding.confirmationState === "confirmed" ? "bound" : "waiting",
    browserMode: "vnc",
    expectedAccountId: binding.accountId,
    expectedEmail: binding.email,
    ...(binding.confirmationState === "confirmed" ? { verificationSource: "manual_confirmation" } : {}),
    lastConfirmedAt: binding.lastConfirmedAt,
  };
}
