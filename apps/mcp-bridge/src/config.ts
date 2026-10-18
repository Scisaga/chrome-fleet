import { readFile } from 'node:fs/promises';

/** Re-read secret files for rotation. Never include file contents in diagnostics. */
export async function readFleetToken(): Promise<string> {
  const value = process.env.FLEET_TOKEN_FILE ? await readFile(process.env.FLEET_TOKEN_FILE, 'utf8') : process.env.FLEET_TOKEN;
  const token = value?.trim();
  if (!token || /\s/.test(token)) throw new Error('需要有效的 FLEET_TOKEN_FILE 或 FLEET_TOKEN');
  return token;
}
export function fleetUrl(): string { return process.env.FLEET_URL ?? 'http://127.0.0.1:8080'; }
