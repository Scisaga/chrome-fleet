import type { Profile } from "./api";

export type BrowserMode = "vnc" | "automation";
export function browserMode(profile?: Pick<Profile, "browserMode">): BrowserMode {
  return profile?.browserMode === "vnc" ? "vnc" : "automation";
}
export const browserModeLabel = (profile?: Pick<Profile, "browserMode">) =>
  browserMode(profile) === "vnc" ? "VNC · 普通 Chrome" : "自动化模式";
export const vncModeDescription = "VNC 模式使用普通 Chrome。系统不读取页面 DOM，不自动填写网站邮箱或密码，也不检测 Google 身份。";
