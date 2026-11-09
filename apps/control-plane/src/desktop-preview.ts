import { FleetError, type Profile } from '@chrome-fleet/contracts';

export interface PreviewFrame { bytes: Buffer; sampledAt: string }
const unavailable = () => new FleetError('DESKTOP_PREVIEW_UNAVAILABLE', '桌面预览暂不可用，请确认实例已运行且镜像支持预览', 503);

/** Bounded, demand-driven cache. Sampling never acquires a lease or changes activity. */
export class DesktopPreviews {
  private frames = new Map<string, PreviewFrame>();
  private epochs = new Map<string, number>();
  private pending = new Map<string, { epoch: number; operation: Promise<PreviewFrame> }>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private bytes = 0;
  private closed = false;
  constructor(private profile: (id: string) => Profile, private capture: (profile: Profile) => Promise<unknown>,
    private budget = 64 * 1024 * 1024, private now = Date.now) {}

  invalidate(id: string, clear = false) {
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
    if (clear) {
      const frame = this.frames.get(id);
      if (frame) this.bytes -= frame.bytes.length;
      this.frames.delete(id);
    }
  }
  private cached(id: string) {
    const frame = this.frames.get(id);
    if (frame) { this.frames.delete(id); this.frames.set(id, frame); }
    return frame;
  }
  private valid(id: string, epoch?: number) {
    if (this.closed) throw unavailable();
    const profile = this.profile(id);
    if (this.closed || profile.archived || profile.purgedAt || (epoch !== undefined && epoch !== (this.epochs.get(id) || 0))) throw unavailable();
    return profile;
  }
  async get(id: string): Promise<PreviewFrame> {
    const profile = this.valid(id);
    const cached = this.cached(id);
    if (profile.state !== 'running' || profile.headless || profile.health?.desktopPreviewAvailable !== true) {
      if (cached) return cached;
      throw unavailable();
    }
    if (cached && this.now() - Date.parse(cached.sampledAt) < 5000) return cached;
    const epoch = this.epochs.get(id) || 0;
    const pending = this.pending.get(id);
    if (pending?.epoch === epoch) return pending.operation;
    const operation = this.sample(id, epoch).catch(error => {
      this.valid(id);
      const previous = this.cached(id);
      if (previous) return previous;
      throw error;
    }).finally(() => {
      if (this.pending.get(id)?.operation === operation) this.pending.delete(id);
    });
    this.pending.set(id, { epoch, operation });
    return operation;
  }
  private async sample(id: string, epoch: number): Promise<PreviewFrame> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      const profile = this.valid(id, epoch);
      if (profile.state !== 'running' || profile.headless) throw unavailable();
      const result = await this.capture(profile) as { mimeType?: string; base64?: string; sampledAt?: string };
      const current = this.valid(id, epoch);
      if (current.state !== 'running' || current.headless) throw unavailable();
      if (result?.mimeType !== 'image/png' || typeof result.base64 !== 'string' || result.base64.length > 1398104 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64) || typeof result.sampledAt !== 'string' ||
          !Number.isFinite(Date.parse(result.sampledAt)) || Date.parse(result.sampledAt) > this.now() + 5000) throw unavailable();
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length < 24 || bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 640 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 400) throw unavailable();
      const frame = { bytes, sampledAt: result.sampledAt };
      const old = this.frames.get(id);
      if (old) this.bytes -= old.bytes.length;
      this.frames.delete(id); this.frames.set(id, frame); this.bytes += bytes.length;
      while (this.bytes > this.budget && this.frames.size) {
        const oldest = this.frames.keys().next().value!;
        this.bytes -= this.frames.get(oldest)!.bytes.length; this.frames.delete(oldest);
      }
      return frame;
    } catch { throw unavailable(); }
    finally {
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    }
  }
  close() {
    this.closed = true; this.frames.clear(); this.bytes = 0;
    for (const resume of this.waiters.splice(0)) resume();
  }
}
