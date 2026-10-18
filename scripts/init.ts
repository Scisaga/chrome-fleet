import { spawnSync } from "node:child_process";
process.exitCode =
  spawnSync("./scripts/fleet", ["init"], { stdio: "inherit", env: process.env })
    .status ?? 1;
