import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
const config = loadConfig();
const { app, service } = await createApp(config);
await service.reconcile();
service.startWorker();
await app.listen({ host: config.host, port: config.port });
process.stderr.write(`Chrome Fleet 已启动：${config.publicUrl}\n`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close().then(() => {
      service.close();
      process.exit(0);
    });
  });
