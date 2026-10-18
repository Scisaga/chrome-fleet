import { loadConfig } from "./config.js";
import { FleetService } from "./service.js";
import { FleetError } from "@chrome-fleet/contracts";

let service: FleetService | undefined;
try {
  if (process.argv.length !== 3)
    throw new FleetError(
      "USAGE",
      "用法：node apps/control-plane/dist/import-google-accounts.js <账号文件路径>",
    );
  service = new FleetService(loadConfig());
  const result = service.google.importFile(process.argv[2]!);
  process.stdout.write(
    `已导入${result.imported}条Google账号，密码已加密保存；尚未绑定或验证登录。\n`,
  );
} catch (error) {
  process.stderr.write(
    error instanceof FleetError
      ? `${error.message}\n`
      : "账号导入失败，请检查文件格式、权限和运行配置\n",
  );
  process.exitCode = 1;
} finally {
  service?.db.close();
}
