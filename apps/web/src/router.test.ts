import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, resolveRoute, routePath, type DetailTab, type View } from "./router";

const profileId = "cf_12345678-abcd-4321-9876-123456789abc";

test("all global pages have stable, refreshable paths", () => {
  for (const view of ["profiles", "accounts", "jobs", "updates", "guide", "mcp"] as View[]) {
    const path = view === "mcp" ? "/integrations/mcp" : `/${view}`;
    const route = parseRoute({ pathname: path });
    assert.equal(route.kind, "page");
    assert.equal(routePath(route), path);
  }
});

test("MCP management has its own canonical URL without claiming the protocol endpoint", () => {
  const route = { kind: "page" as const, view: "mcp" as const };
  assert.equal(routePath(route), "/integrations/mcp");
  assert.deepEqual(parseRoute({ pathname: "/integrations/mcp" }), route);
  const refreshed = resolveRoute({ pathname: "/integrations/mcp/", search: "?job=job_fixture&token=synthetic", hash: "#obsolete" });
  assert.deepEqual(refreshed, { route, path: "/integrations/mcp" });
  assert.deepEqual(parseRoute({ pathname: refreshed.path }), route);
  assert.equal(parseRoute({ pathname: "/integrations/mcp/settings" }).kind, "not-found");
  assert.equal(parseRoute({ pathname: "/mcp" }).kind, "not-found");
  assert.equal(parseRoute({ pathname: "/mcp/" }).kind, "not-found");
});

test("each profile tab round trips through its own URL", () => {
  for (const tab of ["overview", "settings", "accounts", "tasks", "sessions", "updates"] as DetailTab[]) {
    const path = routePath({ kind: "profile", profileId, tab });
    const route = parseRoute({ pathname: path });
    assert.deepEqual(route, { kind: "profile", profileId, tab, ...(tab === "tasks" ? { jobId: undefined } : {}) });
    assert.equal(routePath(route), path);
  }
});

test("root, bare profile and trailing slash aliases canonicalize", () => {
  assert.equal(resolveRoute({ pathname: "/" }).path, "/profiles");
  assert.equal(resolveRoute({ pathname: "/accounts/" }).path, "/accounts");
  assert.equal(resolveRoute({ pathname: `/profiles/${profileId}` }).path, `/profiles/${profileId}/overview`);
  assert.equal(resolveRoute({ pathname: `/profiles/%63${profileId.slice(1)}/settings` }).path, `/profiles/${profileId}/settings`);
});

test("account creation preserves the catalog ID across refresh and legacy bookmarks", () => {
  const route = { kind: "create" as const, from: "accounts" as const, accountId: "ga_synthetic-123" };
  const path = routePath(route);
  assert.equal(path, "/profiles/new?from=accounts&account=ga_synthetic-123");
  assert.deepEqual(parseRoute({ pathname: "/profiles/new", search: "?from=accounts&account=ga_synthetic-123" }), route);
  assert.equal(resolveRoute({ pathname: "/", hash: "#create?from=accounts&account=ga_synthetic-123" }).path, path);
  for (const from of ["profiles", "unknown", ""]) {
    assert.deepEqual(resolveRoute({ pathname: "/profiles/new", search: `?from=${from}&account=ga_synthetic-123` }), { route, path });
  }
});

test("creation links without a valid account return to account management", () => {
  for (const search of ["", "?from=profiles", "?from=accounts", "?from=unknown", "?account=", "?account=..%2Fsecret", `?account=${"a".repeat(201)}`]) {
    assert.deepEqual(resolveRoute({ pathname: "/profiles/new", search }), { route: { kind: "page", view: "accounts" }, path: "/accounts" });
    for (const pathname of ["/", "/profiles"]) {
      assert.deepEqual(resolveRoute({ pathname, hash: `#create${search}` }), { route: { kind: "page", view: "accounts" }, path: "/accounts" });
    }
  }
});

test("job details restore on both the global and profile task pages", () => {
  assert.equal(resolveRoute({ pathname: "/jobs", search: "?job=job_abc-123" }).path, "/jobs?job=job_abc-123");
  assert.equal(resolveRoute({ pathname: `/profiles/${profileId}/tasks`, search: "?job=job_abc-123" }).path, `/profiles/${profileId}/tasks?job=job_abc-123`);
  assert.equal(resolveRoute({ pathname: `/profiles/${profileId}/settings`, search: "?job=job_abc-123" }).path, `/profiles/${profileId}/settings`);
});

test("unknown and malformed profile routes never become profile requests", () => {
  for (const pathname of ["/missing", "/profiles/not-a-profile/settings", "/profiles/%ZZ/settings", `/profiles/${profileId}%2Fother/settings`, `/profiles/${profileId}/missing`, `/profiles/${profileId}/overview/other`, "/profiles/cf_------------------------------------/overview"]) {
    assert.equal(parseRoute({ pathname }).kind, "not-found", pathname);
  }
});

test("only nonsecret identifiers persist in URL query state", () => {
  assert.equal(resolveRoute({ pathname: "/profiles/new", search: "?from=accounts&account=ga_fixture&password=secret&token=secret&vncPassword=secret" }).path, "/profiles/new?from=accounts&account=ga_fixture");
  assert.equal(resolveRoute({ pathname: "/jobs", search: "?job=..%2Fsecret&password=secret" }).path, "/jobs");
  assert.equal(resolveRoute({ pathname: "/guide", search: "?token=secret", hash: "#secret" }).path, "/guide");
});
