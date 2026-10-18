import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(join(root, "db"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "db", "fleet.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }
  migrate() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS leases(profile_id TEXT PRIMARY KEY, owner TEXT,expires_at INTEGER NOT NULL DEFAULT 0,token INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS idempotency(principal TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,response TEXT,PRIMARY KEY(principal,key)); CREATE INDEX IF NOT EXISTS records_collection ON records(collection);`,
    );
    this.db.prepare("INSERT OR IGNORE INTO migrations VALUES(1,?)").run(now());
    this.db.exec("CREATE INDEX IF NOT EXISTS records_jobs_created ON records(json_extract(value, '$.createdAt') DESC, id DESC) WHERE collection = 'jobs'");
  }
  get<T = any>(collection: string, key: string): T | undefined {
    const r = this.db
      .prepare("SELECT value FROM records WHERE collection=? AND id=?")
      .get(collection, key) as any;
    return r ? JSON.parse(r.value) : undefined;
  }
  list<T = any>(collection: string): T[] {
    return (
      this.db
        .prepare("SELECT value FROM records WHERE collection=? ORDER BY rowid")
        .all(collection) as any[]
    ).map((r) => JSON.parse(r.value));
  }
  set<T>(collection: string, key: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value",
      )
      .run(collection, key, JSON.stringify(value));
    return value;
  }
  delete(c: string, k: string) {
    this.db
      .prepare("DELETE FROM records WHERE collection=? AND id=?")
      .run(c, k);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquire(profileId: string, owner: string, ttlMs = 60000): number | undefined {
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO leases(profile_id) VALUES(?)")
        .run(profileId);
      const row = this.db
        .prepare("SELECT * FROM leases WHERE profile_id=?")
        .get(profileId) as any;
      if (row.owner && row.expires_at > Date.now()) return undefined;
      const token = row.token + 1;
      this.db
        .prepare(
          "UPDATE leases SET owner=?,expires_at=?,token=? WHERE profile_id=?",
        )
        .run(owner, Date.now() + ttlMs, token, profileId);
      return token;
    });
  }
  renew(p: string, o: string, t: number, ttl = 60000) {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE leases SET expires_at=? WHERE profile_id=? AND owner=? AND token=? AND expires_at>?",
          )
          .run(Date.now() + ttl, p, o, t, Date.now()).changes,
      ) > 0
    );
  }
  release(p: string, o: string, t: number) {
    this.db
      .prepare(
        "UPDATE leases SET owner=NULL,expires_at=0 WHERE profile_id=? AND owner=? AND token=?",
      )
      .run(p, o, t);
  }
  lease(p: string) {
    return this.db
      .prepare("SELECT * FROM leases WHERE profile_id=?")
      .get(p) as any;
  }
  close() {
    this.db.close();
  }
}
export class Vault {
  key: Buffer;
  keyId: string;
  constructor(
    public root: string,
    keyFile: string,
  ) {
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error("主密钥必须为32字节");
    this.keyId = hash(this.key).slice(0, 16);
    mkdirSync(join(root, "vault"), { recursive: true, mode: 0o700 });
  }
  encrypt(data: Buffer, aad = "artifact"): Buffer {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([Buffer.from("CF01"), iv, cipher.getAuthTag(), body]);
  }
  decrypt(data: Buffer, aad = "artifact") {
    if (data.subarray(0, 4).toString() !== "CF01")
      throw new Error("加密格式不兼容");
    const dec = createDecipheriv("aes-256-gcm", this.key, data.subarray(4, 16));
    dec.setAAD(Buffer.from(aad));
    dec.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([dec.update(data.subarray(32)), dec.final()]);
  }
  put(value: unknown, ref = id("secret")) {
    const file = join(this.root, "vault", ref);
    if (!/^secret_[0-9a-f-]{36}$/.test(ref)) throw new Error("无效secret引用");
    const tmp = file + ".tmp";
    writeFileSync(tmp, this.encrypt(Buffer.from(JSON.stringify(value)), ref), {
      mode: 0o600,
    });
    renameSync(tmp, file);
    return ref;
  }
  get<T = any>(ref: string): T {
    if (!/^secret_[0-9a-f-]{36}$/.test(ref)) throw new Error("无效secret引用");
    return JSON.parse(
      this.decrypt(readFileSync(join(this.root, "vault", ref)), ref).toString(),
    );
  }
}
export function atomicJson(path: string, value: unknown, mode = 0o600) {
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode });
  chmodSync(path + ".tmp", mode);
  renameSync(path + ".tmp", path);
}
