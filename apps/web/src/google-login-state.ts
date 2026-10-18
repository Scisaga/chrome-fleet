import type { GoogleLoginStatus } from "./api";

type AutofillStage = NonNullable<GoogleLoginStatus["autofill"]>["stage"];
const descriptions: Record<AutofillStage, { title: string; description: string }> = {
  waiting: {
    title: "正在准备登录填写辅助",
    description: "系统将填写邮箱，等待你点击邮箱页的下一步；检测进入密码页后填写密码，再由你提交。",
  },
  email_filled: {
    title: "邮箱已填好，请点击下一步",
    description: "请在远程桌面的邮箱页点击下一步。系统检测进入密码页后会填写密码，仍由你确认提交。",
  },
  email_submitted: {
    title: "已检测到你提交邮箱，正在等待密码页",
    description: "你提交邮箱后，系统会检测密码页并填写密码，再等待你确认提交。",
  },
  password_filled: {
    title: "密码已填好，等待你提交",
    description: "请在远程桌面的密码页确认后点击下一步。验证码与二次验证由你完成。",
  },
  manual_required: {
    title: "需要你在桌面继续",
    description: "当前页面需要人工操作，请在远程桌面检查并继续。密码提交、验证码与二次验证由你完成。",
  },
  account_mismatch: {
    title: "当前账号与所选账号不一致",
    description: "系统已停止填写。请在远程桌面检查账号，切换到所选账号后重新打开 Google 登录。",
  },
  unsupported: {
    title: "当前页面无法自动填写",
    description: "请在远程桌面手动继续；当前页面或浏览器 Agent 可能尚不支持填写辅助。",
  },
};

export function googleAutofillSummary(value?: GoogleLoginStatus) {
  if (!value?.autofill) {
    return {
      stage: "not_requested",
      title: "未启用填写辅助",
      description: "需要辅助时，请选择已导入账号并点击 Google 登录；本次可在桌面自行填写凭证。",
    };
  }
  const stage = value.autofill.stage;
  return { stage, ...(descriptions[stage] || descriptions.manual_required) };
}
