import { spawn } from 'node:child_process';
import { AgentError } from './model.js';

export const clipboardLimit = 128 * 1024;
export function validClipboardText(text: unknown): text is string {
  return typeof text === 'string' && !text.includes('\0') && Buffer.byteLength(text, 'utf8') <= clipboardLimit;
}

/** UTF-8 CLIPBOARD selection only. Text travels through pipes, never argv or disk. */
export class X11Clipboard {
  private run(args: string[], input?: string): Promise<{ code: number | null; output: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/xclip', ['-selection', 'clipboard', '-target', 'UTF8_STRING', ...args], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let length = 0, settled = false;
      const finish = (error?: AgentError, code: number | null = null) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (input !== undefined) child.stdout.destroy();
        if (error) reject(error); else resolve({ code, output: Buffer.concat(chunks) });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new AgentError('CLIPBOARD_UNAVAILABLE', '远程剪贴板暂不可用，请稍后重试', 503));
      }, 2000);
      child.once('error', () => finish(new AgentError('CLIPBOARD_UNAVAILABLE', '远程剪贴板组件不可用，请更新浏览器镜像', 503)));
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > clipboardLimit) {
          child.kill('SIGKILL');
          finish(new AgentError('CLIPBOARD_TOO_LARGE', '剪贴板文本不得超过128KiB', 413));
        } else chunks.push(chunk);
      });
      // xclip -in forks its selection owner. Its parent has completed ownership
      // when it exits; do not await inherited pipes held by that owner.
      child.once('exit', code => {
        if (input !== undefined) finish(undefined, code);
      });
      child.once('close', code => finish(undefined, code));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'utf8'));
    });
  }
  async read(assertLease: () => void): Promise<{ text: string }> {
    assertLease();
    const { code, output } = await this.run(['-out']);
    assertLease();
    if (code !== 0 && code !== 1)
      throw new AgentError('CLIPBOARD_UNAVAILABLE', '远程剪贴板读取失败，请稍后重试', 503);
    // An empty selection has no owner/UTF8_STRING target and xclip exits 1.
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
    catch { throw new AgentError('CLIPBOARD_ENCODING_INVALID', '远程剪贴板不是有效UTF-8文本', 409); }
    if (!validClipboardText(text))
      throw new AgentError('CLIPBOARD_TOO_LARGE', '剪贴板文本无效或超过128KiB', 413);
    return { text };
  }
  async write(text: string, assertLease: () => void): Promise<{ written: true }> {
    if (!validClipboardText(text))
      throw new AgentError('CLIPBOARD_TOO_LARGE', '剪贴板文本无效或超过128KiB', 413);
    assertLease();
    const { code } = await this.run(['-in', '-silent'], text);
    assertLease();
    if (code !== 0)
      throw new AgentError('CLIPBOARD_UNAVAILABLE', '远程剪贴板写入失败，请稍后重试', 503);
    return { written: true };
  }
}
