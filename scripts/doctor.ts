import { spawnSync } from "node:child_process";
process.exitCode =
  spawnSync("./scripts/fleet", ["doctor"], {
    stdio: "inherit",
    env: process.env,
  }).status ?? 1;
