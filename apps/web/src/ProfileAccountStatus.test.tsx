import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Profile } from "./api";
import { ProfileAccountEntry, ProfileConfirmationSummary } from "./ProfileAccountStatus";

const binding = { accountId: "google_fixture", email: "fixture@example.test", confirmationState: "unconfirmed" as const };
const profile = (overrides: Partial<Profile>) => ({ id: "cf_fixture", name: "合成实例", googleBinding: binding, ...overrides }) as Profile;
const entry = (value: Profile) => renderToStaticMarkup(<ProfileAccountEntry profile={value} onOpen={() => {}} />);

test("manual confirmation remains visible after changing browser mode", () => {
  for (const browserMode of ["vnc", "automation"] as const) {
    const html = entry(profile({ browserMode, googleBinding: { ...binding, confirmationState: "confirmed", lastConfirmedAt: "2026-10-18T01:02:00.000Z" } }));
    assert.match(html, /已人工确认登录/);
    assert.match(html, /查看详情/);
    assert.doesNotMatch(html, /待人工确认登录|Google 登录|兼容入口/);
  }
});

test("automated authentication and old timestamps cannot become manual confirmation", () => {
  for (const browserMode of ["vnc", "automation"] as const) {
    const html = entry(profile({ browserMode,
      googleBinding: { ...binding, lastConfirmedAt: "2026-10-18T01:02:00.000Z" },
      accounts: [{ id: "account_fixture", provider: "google", alias: "fixture", expectedIdentity: binding.email, authState: "authenticated", lastCheckedAt: "2026-10-18T01:03:00.000Z" }],
    }));
    assert.match(html, /待人工确认登录/);
    assert.match(html, /前往确认/);
    assert.doesNotMatch(html, /已人工确认登录|已验证登录/);
  }
});

test("metadata access stays available in headless and transitional instances, while missing associations are explicit", () => {
  const pending = entry(profile({ browserMode: "automation", headless: true, state: "updating" }));
  assert.match(pending, /待人工确认登录/);
  assert.doesNotMatch(pending, /disabled/);
  const missing = entry(profile({ googleBinding: undefined }));
  assert.match(missing, /账号关联待完善/);
  assert.match(missing, /查看账号/);
  assert.doesNotMatch(missing, /已人工确认登录|前往确认/);
});

test("automation details preserve manual confirmation records and guide unconfirmed instances to manual confirmation", () => {
  const render = (value: Profile) => renderToStaticMarkup(<ProfileConfirmationSummary profile={value} onOpenSettings={() => {}} />);
  const confirmed = render(profile({ browserMode: "automation", googleBinding: { ...binding, confirmationState: "confirmed", lastConfirmedAt: "2026-10-18T01:02:00.000Z" } }));
  assert.match(confirmed, /已人工确认登录/);
  assert.match(confirmed, /人工确认时间/);
  assert.match(confirmed, /fixture@example.test/);
  assert.doesNotMatch(confirmed, /前往实例设置|尚未进行人工确认/);
  const pending = render(profile({ browserMode: "automation" }));
  assert.match(pending, /待人工确认登录/);
  assert.match(pending, /桌面完成登录/);
  assert.match(pending, /前往实例设置/);
  assert.doesNotMatch(pending, /人工确认时间/);
});

test("retired account-page results cannot override manual confirmation on any card", () => {
  const value = profile({ browserMode: "automation", googleBinding: { ...binding, confirmationState: "confirmed", lastConfirmedAt: "2026-10-01T01:02:00.000Z" },
    accounts: [{ id: "account_google", provider: "google", alias: "fixture", expectedIdentity: "fixture@example.test", authState: "needs_login", lastVerificationSource: "account_page", lastCheckedAt: "2026-10-22T01:00:00.000Z" }] });
  const html = entry(value);
  assert.match(html, /已人工确认登录/);
  assert.doesNotMatch(html, /Google · 需要登录/);
  const history = renderToStaticMarkup(<ProfileConfirmationSummary profile={value} onOpenSettings={() => {}} />);
  assert.match(history, /已人工确认登录/);
  assert.match(history, /人工确认时间/);
});

test("returning to ordinary Chrome displays manual confirmation instead of an old automated failure", () => {
  const html = entry(profile({ browserMode: "vnc", googleBinding: { ...binding, confirmationState: "confirmed", lastConfirmedAt: "2026-10-01T01:02:00.000Z" },
    accounts: [{ id: "account_google", provider: "google", alias: "fixture", expectedIdentity: "fixture@example.test", authState: "needs_login", lastVerificationSource: "account_page", lastCheckedAt: "2026-10-22T01:00:00.000Z" }] }));
  assert.match(html, /已人工确认登录/);
  assert.doesNotMatch(html, /Google · 需要登录/);
});
