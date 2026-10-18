import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../mcp-bridge/src/index.js";
import { mcpGroups } from "./mcp-catalog";

test("the user catalog matches every registered MCP tool and its actual scope", async () => {
  let apiCalls = 0;
  const server = createMcpServer(async () => {
    apiCalls++;
    throw new Error("CATALOG_TEST_MUST_NOT_CALL_API");
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "web-catalog-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const registered = (await client.listTools()).tools;
    const displayed = mcpGroups.flatMap((group) => group.tools);
    assert.equal(mcpGroups.length, 6);
    assert.equal(new Set(mcpGroups.map((group) => group.id)).size, 6);
    assert.equal(displayed.length, 35);
    assert.equal(new Set(displayed.map((tool) => tool.name)).size, 35);
    assert.deepEqual(
      displayed.map((tool) => tool.name).sort(),
      registered.map((tool) => tool.name).sort(),
    );
    for (const tool of registered) {
      const entry = displayed.find((item) => item.name === tool.name)!;
      assert.deepEqual(tool._meta?.["chrome-fleet/scopes"], [entry.scope], tool.name);
      assert.ok(entry.description.trim().length > 0, tool.name);
    }
    assert.equal(apiCalls, 0, "tool discovery must remain independent of the control API and Chrome");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the catalog separates VNC-safe management from automation and deferred upgrades", () => {
  const tools = new Map(mcpGroups.flatMap((group) => group.tools).map((tool) => [tool.name, tool]));
  const automationOnly = [
    "profiles_proxy_test", "accounts_check", "jobs_submit",
    "browser_pages_list", "browser_navigate", "browser_click", "browser_fill", "browser_extract", "browser_screenshot",
    "cookies_export", "cookies_import", "storage_state_export", "storage_state_import",
  ];
  assert.deepEqual(
    [...tools.values()].filter((tool) => tool.mode === "automation").map((tool) => tool.name).sort(),
    automationOnly.sort(),
  );
  for (const name of [
    "profiles_start", "profiles_stop", "profiles_restart", "profiles_get",
    "profiles_proxy_set", "profiles_vnc_password_set", "manual_session_open", "manual_session_close",
    "jobs_get", "jobs_cancel", "jobs_resume", "profiles_backup", "profiles_restore", "browser_updates_rollback",
  ]) assert.equal(tools.get(name)?.mode, "all", name);
  assert.deepEqual([...tools.values()].filter((tool) => tool.mode === "conditional").map((tool) => tool.name), ["browser_updates_apply"]);
  assert.match(tools.get("browser_updates_apply")!.description, /VNC.*延后/);
  assert.match(tools.get("profiles_create")!.description, /VNC.*设置.*切换/);
  assert.match(tools.get("browser_updates_rollback")!.description, /覆盖恢复点之后/);
});
