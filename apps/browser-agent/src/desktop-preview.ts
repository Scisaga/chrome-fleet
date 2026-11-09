import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { AgentError } from './model.js';

export const previewByteLimit = 1024 * 1024;
const unavailable = () => new AgentError('DESKTOP_PREVIEW_UNAVAILABLE', '桌面预览暂不可用', 503);
export interface DesktopPreview { mimeType: 'image/png'; base64: string; sampledAt: string }

/** Reads X11 pixels only. No browser connection, input events, or fencing lease. */
export class X11Preview {
  private pending?: Promise<DesktopPreview>;
  private cancel?: () => void;
  constructor(private start: typeof spawn = spawn, private timeoutMs = 3000) {}
  available() { return existsSync('/usr/bin/import') && existsSync('/usr/bin/convert'); }
  capture(): Promise<DesktopPreview> {
    if (this.pending) return this.pending;
    const operation = new Promise<DesktopPreview>((resolve, reject) => {
      const options = {
        env: { ...process.env, MAGICK_MEMORY_LIMIT: '32MiB', MAGICK_MAP_LIMIT: '0', MAGICK_DISK_LIMIT: '0', MAGICK_THREAD_LIMIT: '1' },
      };
      const child = this.start('/usr/bin/import', ['-display', ':99', '-window', 'root', '-silent', 'png:-'], { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
      // Debian ImageMagick 6 import accepts -resize but does not apply it to the root capture.
      const resized = this.start('/usr/bin/convert', ['png:-', '-resize', '640x400>', '-depth', '8', '-strip', 'png:-'], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout?.pipe(resized.stdin!);
      const chunks: Buffer[] = [];
      let length = 0, settled = false, captured = false, converted = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancel = undefined;
        if (!ok) { child.kill('SIGKILL'); resized.kill('SIGKILL'); reject(unavailable()); return; }
        const bytes = Buffer.concat(chunks);
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
            bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 640 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 400) {
          reject(unavailable()); return;
        }
        resolve({ mimeType: 'image/png', base64: bytes.toString('base64'), sampledAt: new Date().toISOString() });
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.cancel = () => finish(false);
      child.once('error', () => finish(false));
      resized.once('error', () => finish(false));
      resized.stdin?.on('error', () => finish(false));
      resized.stdout?.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > previewByteLimit) finish(false); else chunks.push(chunk);
      });
      child.once('close', code => { captured = code === 0; if (!captured) finish(false); else if (converted) finish(true); });
      resized.once('close', code => { converted = code === 0; if (!converted) finish(false); else if (captured) finish(true); });
    });
    this.pending = operation.finally(() => { this.pending = undefined; });
    return this.pending;
  }
  close() { this.cancel?.(); }
}

export function installDesktopPreview(app: FastifyInstance, running: () => boolean, sampler = new X11Preview()) {
  app.get('/desktop/preview', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!running() || !sampler.available()) throw unavailable();
    const result = await sampler.capture();
    if (!running()) throw unavailable();
    return result;
  });
  app.addHook('onClose', async () => { sampler.close(); });
  return () => running() && sampler.available();
}
