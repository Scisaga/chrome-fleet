/** Explicit, memory-only UTF-8 clipboard controls, including insecure HTTP fallback. */
export const desktopClipboardModule = String.raw`
import UI from './app/ui.js';

const metadata = document.querySelector('meta[name="fleet-desktop-context"]');
const context = { sessionId: metadata?.dataset.sessionId, version: Number(metadata?.dataset.version) };
const profileId = metadata?.dataset.profileId;
const valid = /^cf_[0-9a-f-]{36}$/.test(profileId || '') && /^manual_[0-9a-f-]{36}$/.test(context.sessionId || '') && Number.isSafeInteger(context.version) && context.version > 0;
const limit = 128 * 1024;
let controller;
let generation = 0;
let closed = false;
let busy = false;
let visible = false;
const style = document.createElement('style');
style.textContent = '#fleet_clipboard_button{position:fixed;right:12px;top:12px;z-index:10000;padding:9px 15px;border:1px solid #8072af;border-radius:7px;background:#252137;color:#fff;font:600 14px system-ui;cursor:pointer;box-shadow:0 2px 12px #0006}#fleet_clipboard_panel{position:fixed;right:12px;top:58px;z-index:10001;box-sizing:border-box;width:min(440px,calc(100vw - 24px));max-height:calc(100vh - 74px);overflow:auto;padding:17px;border:1px solid #716387;border-radius:9px;background:#211e2c;color:#f5f2fc;box-shadow:0 8px 32px #0008;font:14px/1.6 system-ui}#fleet_clipboard_panel[hidden]{display:none}#fleet_clipboard_panel h2{margin:0;font-size:17px}#fleet_clipboard_panel p{margin:8px 0;color:#d2cbdf;font-size:13px}#fleet_clipboard_text{box-sizing:border-box;width:100%;height:160px;min-height:80px;max-height:40vh;resize:vertical;padding:10px;border:1px solid #746781;border-radius:5px;background:#15131d;color:#fff;font:14px/1.5 system-ui}#fleet_clipboard_panel button{padding:7px 11px;border:1px solid #80728d;border-radius:5px;background:#393047;color:white;font:14px system-ui;cursor:pointer}#fleet_clipboard_panel button:disabled{opacity:.5;cursor:default}#fleet_clipboard_actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}#fleet_clipboard_close{float:right}#fleet_clipboard_status{min-height:22px;margin-top:10px;color:#d4c6ff;font-size:13px;overflow-wrap:anywhere}#noVNC_clipboard{display:none!important}';
document.head.appendChild(style);
const opener = document.createElement('button');
opener.id = 'fleet_clipboard_button'; opener.type = 'button'; opener.textContent = '剪贴板';
opener.setAttribute('aria-controls', 'fleet_clipboard_panel'); opener.setAttribute('aria-expanded', 'false');
const panel = document.createElement('section');
panel.id = 'fleet_clipboard_panel'; panel.hidden = true; panel.setAttribute('aria-label', '桌面剪贴板');
panel.innerHTML = '<button id="fleet_clipboard_close" type="button" aria-label="关闭剪贴板">关闭</button><h2>桌面剪贴板</h2><p id="fleet_clipboard_help">本机 → 远程：在下方按 Ctrl+V（Mac 为 ⌘V）粘贴文本，点击发送，再在远程窗口按 Ctrl+V。<br>远程 → 本机：在远程窗口复制文本，点击读取，再复制到本机。</p><textarea id="fleet_clipboard_text" maxlength="131072" aria-label="剪贴板文本" aria-describedby="fleet_clipboard_help" placeholder="在此粘贴或读取文本（最多 128KiB）" spellcheck="false" autocomplete="off"></textarea><div id="fleet_clipboard_actions"><button id="fleet_clipboard_send" type="button">发送到远程</button><button id="fleet_clipboard_read" type="button">读取远程剪贴板</button><button id="fleet_clipboard_copy" type="button">复制到本机</button></div><div id="fleet_clipboard_status" role="status" aria-live="polite"></div>';
document.body.append(opener, panel);
const text = document.getElementById('fleet_clipboard_text');
const send = document.getElementById('fleet_clipboard_send');
const read = document.getElementById('fleet_clipboard_read');
const copy = document.getElementById('fleet_clipboard_copy');
const message = document.getElementById('fleet_clipboard_status');
const closeButton = document.getElementById('fleet_clipboard_close');
const ready = () => valid && !closed && document.documentElement.dataset.fleetDesktopState === 'connected';
const acceptable = value => typeof value === 'string' && !value.includes('\0') && new TextEncoder().encode(value).length <= limit;
function note(value) { message.textContent = value; }
function controls() { send.disabled = read.disabled = busy || !ready(); copy.disabled = busy || !ready(); }
function clear() {
  generation++; controller?.abort(); controller = undefined; busy = false;
  text.value = '';
  const originalText = document.getElementById('noVNC_clipboard_text');
  if (originalText) originalText.value = '';
  controls();
}
function hide() { visible = false; panel.hidden = true; opener.setAttribute('aria-expanded', 'false'); clear(); note(''); }
function show(event) {
  event?.preventDefault(); event?.stopImmediatePropagation();
  visible = true; panel.hidden = false; opener.setAttribute('aria-expanded', 'true'); controls();
  note(ready() ? '文本仅保留在当前面板；关闭面板或断开连接即清除。' : '请先连接远程桌面。');
  text.focus();
}
async function transfer(action) {
  if (!ready() || busy) return;
  const value = text.value;
  if (action === 'write' && !acceptable(value)) { note('文本无效或超过 128KiB，请缩短后重试。'); return; }
  busy = true; controls();
  const run = ++generation;
  const request = new AbortController(); controller = request;
  note(action === 'read' ? '正在读取远程剪贴板…' : '正在发送到远程剪贴板…');
  try {
    const login = await fetch('/api/v1/session', { credentials:'same-origin', cache:'no-store', redirect:'error', signal:request.signal });
    const session = await login.json();
    if (!login.ok || typeof session.data?.csrfToken !== 'string') throw new Error('expired');
    const response = await fetch('/profiles/' + profileId + '/desktop/clipboard', {
      method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error', signal:request.signal,
      headers:{'Content-Type':'application/json','X-CSRF-Token':session.data.csrfToken},
      body:JSON.stringify({...context, action, ...(action === 'write' ? {text:value} : {})}),
    });
    if (!response.ok) { const error = new Error('transfer'); error.status = response.status; throw error; }
    const result = await response.json();
    if (request.signal.aborted || generation !== run || !ready() || !visible) return;
    if (action === 'read') {
      if (!acceptable(result.data?.text)) throw new Error('invalid');
      text.value = result.data.text;
      note(text.value ? '已读取远程文本，可点击“复制到本机”。' : '远程剪贴板当前没有文本。');
    } else note('已发送到远程剪贴板，请在远程窗口按 Ctrl+V（Mac 客户端也使用远程 Ctrl+V）粘贴。');
  } catch(error) {
    if (!request.signal.aborted && generation === run) {
      if ([401,403,409,410].includes(error.status) || error.message === 'expired') {
        clear(); note('桌面会话已失效，请从实例重新打开桌面。');
      } else if (error.status === 413) note('文本超过 128KiB，请缩短后重试。');
      else note('剪贴板暂不可用，请确认浏览器镜像已更新后重试。');
    }
  } finally { if (generation === run) { busy = false; controller = undefined; controls(); } }
}
async function copyLocal() {
  if (!ready() || busy || !acceptable(text.value)) return;
  const value = text.value;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      if (visible && ready()) note('已复制到本机剪贴板。');
      return;
    }
  } catch { /* Explicit browser permission denied: offer the HTTP fallback. */ }
  if (!visible || !ready()) return;
  text.focus(); text.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  note(copied ? '已复制到本机剪贴板。' : '浏览器限制自动复制，文本已选中，请按 Ctrl+C（Mac 为 ⌘C）。');
}
opener.addEventListener('click', show);
closeButton.addEventListener('click', hide);
send.addEventListener('click', () => transfer('write'));
read.addEventListener('click', () => transfer('read'));
copy.addEventListener('click', copyLocal);
for (const name of ['keydown','keyup','keypress']) panel.addEventListener(name, event => { event.stopPropagation(); if (name === 'keydown' && event.key === 'Escape') hide(); });
// Route both noVNC's original toolbar button and its public hooks through this
// panel. The Debian UI's originals log clipboard prefixes and truncate Unicode.
UI.toggleClipboardPanel = show;
UI.clipboardReceive = () => { if (visible && !busy) note('远程剪贴板已变化，点击“读取远程剪贴板”获取文本。'); };
UI.clipboardSend = () => transfer('write');
UI.clipboardClear = () => { text.value = ''; return transfer('write'); };
const originalButton = document.getElementById('noVNC_clipboard_button');
originalButton?.addEventListener('click', show, true);
new MutationObserver(() => {
  if (!ready()) { clear(); if (visible) note('桌面连接已断开，面板文本已清除。'); }
  controls();
}).observe(document.documentElement, { attributes:true, attributeFilter:['data-fleet-desktop-state'] });
window.addEventListener('pagehide', () => { closed = true; hide(); });
controls();
`;
