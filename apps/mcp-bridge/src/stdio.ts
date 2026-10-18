#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FleetClient } from '@chrome-fleet/sdk';
import { createMcpServer } from './index.js';
import { fleetUrl, readFleetToken } from './config.js';

try {
  await readFleetToken();
  const client = new FleetClient({ baseUrl: fleetUrl(), token: readFleetToken });
  const server = createMcpServer(client.call);
  await server.connect(new StdioServerTransport());
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => { void server.close().finally(() => process.exit(0)); });
} catch {
  process.stderr.write('Chrome Fleet MCP 启动失败；检查控制服务地址及平台凭证文件。\n');
  process.exitCode = 1;
}
