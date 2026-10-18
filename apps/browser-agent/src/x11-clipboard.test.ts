import test from 'node:test';
import assert from 'node:assert/strict';
import { X11Clipboard, validClipboardText, clipboardLimit } from './x11-clipboard.js';

test('clipboard limit counts UTF-8 bytes and rejects NUL without rejecting Unicode or empty text', () => {
  assert.equal(validClipboardText('中文 🦊\nline'), true);
  assert.equal(validClipboardText(''), true);
  assert.equal(validClipboardText('a'.repeat(clipboardLimit)), true);
  assert.equal(validClipboardText('中'.repeat(44_000)), false);
  assert.equal(validClipboardText('bad\0text'), false);
});

test('X11 clipboard checks the lease before and after an asynchronous UTF-8 transfer and sanitizes malformed results', async () => {
  const clipboard = new X11Clipboard();
  let active = true, calls = 0, checks = 0;
  const assertLease = () => { checks++; if (!active) throw new Error('synthetic expired lease'); };
  // Only the OS process is replaced here. A real X11/Chrome roundtrip is tested
  // separately by the live fixture, not claimed by this unit test.
  (clipboard as any).run = async (_args: string[], input?: string) => {
    calls++; return { code: 0, output: Buffer.from(input ?? '中文 🦊', 'utf8') };
  };
  assert.deepEqual(await clipboard.read(assertLease), { text: '中文 🦊' });
  assert.deepEqual(await clipboard.write('中文 🦊', assertLease), { written: true });
  assert.equal(calls, 2); assert.equal(checks, 4);
  active = false;
  await assert.rejects(clipboard.write('must not be sent', assertLease), /expired lease/);
  assert.equal(calls, 2);
  active = true;
  (clipboard as any).run = async () => { active = false; return { code: 0, output: Buffer.from('must-not-release') }; };
  await assert.rejects(clipboard.read(assertLease), /expired lease/);
  (clipboard as any).run = async () => ({ code: 0, output: Buffer.from([0xff]) });
  await assert.rejects(clipboard.read(() => {}), (error: any) => error.code === 'CLIPBOARD_ENCODING_INVALID');
  (clipboard as any).run = async () => ({ code: 2, output: Buffer.from('synthetic-sensitive-command-error') });
  await assert.rejects(clipboard.read(() => {}), (error: any) => error.code === 'CLIPBOARD_UNAVAILABLE' && !error.message.includes('synthetic-sensitive'));
});
