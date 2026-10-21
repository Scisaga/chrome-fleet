import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, items, message, type Platform, type PlatformInput } from "./api";
import { Badge, Button, Empty, Field, Modal, Notice } from "./components";
import "./platforms.css";

export async function loadPlatforms() {
  const first = await api<{ items: Platform[]; total: number }>("/platforms?limit=100");
  const platforms = [...items(first)];
  while (platforms.length < first.total) {
    const page = items<Platform>(await api(`/platforms?limit=100&offset=${platforms.length}`));
    if (!page.length) break;
    platforms.push(...page);
  }
  return platforms;
}

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ platform?: Platform }>();
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try { setPlatforms(await loadPlatforms()); setError(""); }
    catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function change(platform: Platform, remove = false) {
    setBusy(platform.id); setError("");
    try {
      await api(`/platforms/${platform.id}`, remove ? "DELETE" : "PATCH", remove ? undefined : { enabled: !platform.enabled });
      await load();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(""); }
  }
  return <section>
    <div className="page-heading"><div><div className="eyebrow">PLATFORMS</div><h1>平台管理</h1><p>维护 Google 关联平台的首页、登录入口和账户设置页地址。</p></div><div className="heading-actions"><Button icon="refresh" busy={loading} onClick={() => void load()}>刷新</Button><Button icon="plus" variant="primary" onClick={() => setEditor({})}>新增平台</Button></div></div>
    <Notice>请在浏览器实例详情中登记关联平台，并在桌面完成登录后人工确认。这里的地址供用户自行访问。</Notice>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="platform-grid">{platforms.map(platform => <article className="panel platform-config" key={platform.id} data-platform-id={platform.id}>
      <div className="panel-heading"><h2>{platform.name}</h2><Badge value={platform.enabled ? "authenticated" : "stopped"} label={platform.builtin ? "内置" : platform.enabled ? "已启用" : "已停用"} /></div>
      <dl className="info-list"><div><dt>平台首页</dt><dd>{platform.homeUrl}</dd></div><div><dt>账户设置页</dt><dd>{platform.accountUrl}</dd></div><div><dt>登录入口</dt><dd>{platform.loginUrl}</dd></div></dl>
      {!platform.builtin && <div className="heading-actions"><Button icon="edit" onClick={() => setEditor({ platform })}>编辑</Button><Button busy={busy === platform.id} onClick={() => void change(platform)}>{platform.enabled ? "停用" : "启用"}</Button><Button variant="danger" disabled={busy === platform.id} onClick={() => void change(platform, true)}>删除</Button></div>}
    </article>)}</div>
    {!loading && !platforms.length && <Empty title="暂无平台" />}
    {editor && <PlatformEditor platform={editor.platform} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); void load(); }} />}
  </section>;
}

function PlatformEditor({ platform, onClose, onSaved }: { platform?: Platform; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) || "").trim();
    const input: PlatformInput = {
      name: text("name"), homeUrl: text("homeUrl"), loginUrl: text("loginUrl"), accountUrl: text("accountUrl"),
      enabled: form.has("enabled"),
    };
    try { await api(platform ? `/platforms/${platform.id}` : "/platforms", platform ? "PATCH" : "POST", input); onSaved(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={platform ? "编辑平台" : "新增平台"} onClose={onClose} wide>
    <form onSubmit={event => void save(event)} className="platform-editor">
      <div className="form-grid"><Field label="平台名称"><input name="name" required maxLength={80} defaultValue={platform?.name} /></Field><Field label="平台首页"><input name="homeUrl" type="url" required defaultValue={platform?.homeUrl} placeholder="https://example.com/" /></Field><Field label="登录入口"><input name="loginUrl" type="url" required defaultValue={platform?.loginUrl} placeholder="https://example.com/login" /></Field><Field label="账户设置页"><input name="accountUrl" type="url" required defaultValue={platform?.accountUrl} placeholder="https://example.com/settings/account" /></Field></div>
      <label className="check-field"><input name="enabled" type="checkbox" defaultChecked={platform?.enabled ?? true} />启用平台</label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存平台</Button></div>
    </form>
  </Modal>;
}
