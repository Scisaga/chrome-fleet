export interface DesktopFramePreview { url: string; sampledAt: string; bytes: number }

/** One in-memory thumbnail per instance; never persisted to browser storage. */
export class DesktopFramePreviews {
  private frames = new Map<string, DesktopFramePreview>();
  private listeners = new Set<() => void>();
  private bytes = 0;
  generation = 0;
  constructor(private budget = 64 * 1024 * 1024) {}
  get = (id: string) => this.frames.get(id);
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  put(id: string, blob: Blob, sampledAt: string) {
    if (blob.type !== 'image/png' || !blob.size || blob.size > 1024 * 1024 || !Number.isFinite(Date.parse(sampledAt))) return;
    this.remove(id);
    this.frames.set(id, { url: URL.createObjectURL(blob), sampledAt, bytes: blob.size });
    this.bytes += blob.size;
    while (this.bytes > this.budget && this.frames.size) this.remove(this.frames.keys().next().value!);
    this.changed();
  }
  private remove(id: string) {
    const frame = this.frames.get(id);
    if (!frame) return false;
    URL.revokeObjectURL(frame.url); this.bytes -= frame.bytes; this.frames.delete(id); return true;
  }
  forget(id: string) { if (this.remove(id)) this.changed(); }
  retain(ids: Set<string>) {
    let changed = false;
    for (const id of this.frames.keys()) if (!ids.has(id)) changed = this.remove(id) || changed;
    if (changed) this.changed();
  }
  clear() {
    this.generation++;
    for (const id of this.frames.keys()) this.remove(id);
    this.changed();
  }
}

export const desktopFramePreviews = new DesktopFramePreviews();

/** Scale an already authenticated VNC framebuffer; this never sends input or opens a session. */
export function thumbnailFromCanvas(source: HTMLCanvasElement): Promise<Blob | null> {
  if (source.width < 320 || source.height < 240) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const target = source.ownerDocument.createElement('canvas');
      const ratio = Math.min(640 / source.width, 400 / source.height, 1);
      target.width = Math.max(1, Math.floor(source.width * ratio)); target.height = Math.max(1, Math.floor(source.height * ratio));
      const context = target.getContext('2d');
      if (!context) { resolve(null); return; }
      context.drawImage(source, 0, 0, target.width, target.height);
      target.toBlob(resolve, 'image/png');
    } catch { resolve(null); }
  });
}
