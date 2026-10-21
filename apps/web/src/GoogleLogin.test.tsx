// Run from the workspace root with TSX_TSCONFIG_PATH=apps/web/tsconfig.json.
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GoogleLoginDialog, GoogleLoginProgress } from "./GoogleLogin";
import { Badge } from "./components";
import { browserMode } from "./browser-mode";
import { bindingProgress, googleBindingLabel } from "./google-binding";
import VncGoogleBindingPanel from "./VncGoogleBindingPanel";
import BrowserModeSettings from "./BrowserModeSettings";
import type { GoogleLoginStatus, Profile } from "./api";

test("VNC waiting state shows the chosen email and explicit manual confirmation without DOM detection", () => {
  const html = renderToStaticMarkup(<GoogleLoginProgress
    value={{ status: "waiting", browserMode: "vnc", expectedAccountId: "google_fixture", expectedEmail: "vnc-fixture@example.test" }}
    onConfirm={() => {}}
  />);
  assert.match(html, /已绑定账号：vnc-fixture@example.test/);
  assert.match(html, /已绑定，待人工确认/);
  assert.match(html, /确认已登录/);
  assert.match(html, /无需重新打开桌面/);
  assert.match(html, /确认只保存人工记录/);
  assert.match(html, /桌面会话保持不变/);
  assert.doesNotMatch(html, /切换到自动化接管|结束人工桌面/);
  assert.doesNotMatch(html, /重新检测|data-autofill-stage|密码已填好|手动填写后识别|人工登录后自动识别/);
});

test("VNC confirmed mappings are explicitly a person's statement, never server verification", () => {
  const html = renderToStaticMarkup(<GoogleLoginProgress value={{ status: "bound", browserMode: "vnc", verificationSource: "manual_confirmation", expectedEmail: "vnc-fixture@example.test", lastConfirmedAt: "2026-10-01T01:02:00.000Z" }} onConfirm={() => {}} />);
  assert.match(html, /已人工确认登录/);
  assert.match(html, /人工确认时间/);
  assert.match(html, /<button[^>]*class="button default [^"]*"[^>]*>更新登录确认<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>确认已登录<\/button>/);
  assert.match(html, /仅|人工确认|人工登录确认/);
  assert.doesNotMatch(html, /Google 账号已识别并绑定|已验证登录|重新检测|确认已登录并绑定/);
  assert.match(renderToStaticMarkup(<Badge value="manually_confirmed" />), /人工确认/);
});

test("VNC Google dialog offers cancel and login without a duplicate desktop action", () => {
  const profile = { id: "cf_fixture", name: "VNC fixture", browserMode: "vnc", googleBinding: { accountId: "google_fixture", email: "vnc-fixture@example.test", confirmationState: "unconfirmed" } } as Profile;
  const html = renderToStaticMarkup(<GoogleLoginDialog profile={profile} onClose={() => {}} onStart={() => {}} />);
  assert.match(html, /取消/);
  assert.doesNotMatch(html, /仅打开桌面，不绑定账号/);
  assert.match(html, /打开VNC登录/);
  assert.match(html, /已绑定账号/);
  assert.match(html, /vnc-fixture@example.test/);
  assert.match(html, /确认登录只保存人工记录/);
  assert.doesNotMatch(html, /确认登录后会结束人工桌面/);
  assert.doesNotMatch(html, /<select|待绑定 Google 账号/);
  assert.doesNotMatch(html, /手动填写后识别|系统会填写所选账号|由自动化模式检测身份|自动识别并绑定/);
  assert.doesNotMatch(html, /type="password"/);
});

test("binding presence never implies login confirmation and confirmation time persists", () => {
  const binding = { accountId: "google_fixture", email: "vnc-fixture@example.test", confirmationState: "unconfirmed" as const };
  const pending = bindingProgress(binding);
  assert.equal(pending.status, "waiting");
  assert.equal(pending.verificationSource, undefined);
  assert.equal(googleBindingLabel(binding), "已绑定，待人工确认");
  const confirmed = bindingProgress({ ...binding, confirmationState: "confirmed", lastConfirmedAt: "2026-10-01T01:02:00.000Z" });
  assert.equal(confirmed.status, "bound");
  assert.equal(confirmed.verificationSource, "manual_confirmation");
  assert.equal(confirmed.lastConfirmedAt, "2026-10-01T01:02:00.000Z");
});

test("a bound VNC profile exposes manual confirmation without a desktop session", () => {
  const profile = { id: "cf_fixture", name: "VNC fixture", browserMode: "vnc", googleBinding: { accountId: "google_fixture", email: "vnc-fixture@example.test", confirmationState: "unconfirmed" } } as Profile;
  const html = renderToStaticMarkup(<VncGoogleBindingPanel profile={profile} reload={async () => {}} notify={() => {}} onLogin={() => {}} onConfirm={() => {}} onOpenDesktop={() => {}} busy={false} confirming={false} />);
  assert.match(html, /确认已登录/);
  assert.match(html, /已绑定账号：vnc-fixture@example.test/);
  assert.match(html, /确认已登录只保存人工记录/);
  assert.match(html, /浏览器模式和桌面会话保持不变/);
  assert.doesNotMatch(html, /使用原用户目录重启 Chrome/);
  assert.doesNotMatch(html, /最近检测|待检测|检测登录状态|<select/);
});

test("an unbound VNC login dialog cannot open an arbitrary catalog account", () => {
  const profile = { id: "cf_fixture", name: "VNC fixture", browserMode: "vnc" } as Profile;
  const html = renderToStaticMarkup(<GoogleLoginDialog profile={profile} onClose={() => {}} onStart={() => {}} />);
  assert.match(html, /尚未绑定，请先到账号状态页保存绑定/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?打开VNC登录/);
  assert.doesNotMatch(html, /<select|手动填写后识别/);
});

test("old profiles keep automation compatibility while explicit VNC profiles stay VNC", () => {
  assert.equal(browserMode({}), "automation");
  assert.equal(browserMode({ browserMode: "vnc" }), "vnc");
  assert.equal(browserMode({ browserMode: "automation" }), "automation");
});

test("the mode selector names the active mode without offering an unchanged switch", () => {
  for (const mode of ["vnc", "automation"] as const) {
    const profile = { id: "cf_fixture", name: "Mode fixture", browserMode: mode, state: "running" } as Profile;
    const html = renderToStaticMarkup(<BrowserModeSettings profile={profile} reload={async () => {}} notify={() => {}} />);
    assert.match(html, /<button[^>]*disabled=""[^>]*>当前模式<\/button>/);
    assert.doesNotMatch(html, /切换为 VNC 模式|切换为自动化模式/);
    const hintId = html.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(hintId);
    assert.ok(html.includes(`id="${hintId}"`));
    assert.match(html, /用户目录与账号映射会保留/);
  }
});

test("automation mode also renders manual confirmation without identity polling or autofill", () => {
  const html = renderToStaticMarkup(<GoogleLoginProgress value={{ status: "waiting", browserMode: "automation", expectedAccountId: "google_fixture", expectedEmail: "fixture@example.test" }} onConfirm={() => {}} />);
  assert.match(html, /确认已登录/);
  assert.match(html, /人工记录/);
  assert.doesNotMatch(html, /重新检测|自动填写|已识别/);
});
