import Fastify from 'fastify';
import { FleetClient } from '@chrome-fleet/sdk';
import { installMcpHttp } from './index.js';
import { fleetUrl } from './config.js';

// Deliberately local-only. Public remote MCP requires OAuth, which is not supplied here.
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
await installMcpHttp(app, request => {
  const token = request.headers.authorization?.slice(7);
  return new FleetClient({ baseUrl: fleetUrl(), token }).call;
});
try {
  await app.listen({ host: '127.0.0.1', port: Number(process.env.FLEET_MCP_PORT ?? 8093) });
  process.stderr.write('Chrome Fleet 本地 MCP HTTP 已启动。\n');
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => { void app.close().finally(() => process.exit(0)); });
} catch {
  process.stderr.write('Chrome Fleet MCP HTTP 启动失败；检查监听端口。\n');
  process.exitCode = 1;
}
