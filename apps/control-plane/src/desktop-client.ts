/** Same-origin, authenticated noVNC adapter. The module contains no credentials. */
export const desktopClientModule = String.raw`
import UI from './app/ui.js';

const metadata = document.querySelector('meta[name="fleet-desktop-context"]');
const context = {
  profileId: metadata?.dataset.profileId,
  sessionId: metadata?.dataset.sessionId,
  version: Number(metadata?.dataset.version),
};
const validContext = /^cf_[0-9a-f-]{36}$/.test(context.profileId || '') &&
  /^manual_[0-9a-f-]{36}$/.test(context.sessionId || '') &&
  Number.isSafeInteger(context.version) && context.version > 0;
const base = '/profiles/' + context.profileId + '/desktop/';
const boundPath = base.slice(1) + 'websockify?sessionId=' +
  encodeURIComponent(context.sessionId) + '&version=' + context.version;
const supplied = new WeakSet();
const attached = new WeakSet();
let closed = false;
let blocked = !validContext;
let connecting = false;
let epoch = 0;
let activeRequest;
const originalConnect = UI.connect;
const originalDisconnect = UI.disconnect;
const originalDisconnectFinished = UI.disconnectFinished;
const originalGetSetting = UI.getSetting;

function state(value) { document.documentElement.dataset.fleetDesktopState = value; }
function inhibitReconnect() {
  UI.inhibitReconnect = true;
  UI.reconnectPassword = null;
  if (UI.reconnectCallback != null) clearTimeout(UI.reconnectCallback);
  UI.reconnectCallback = null;
}
function status(message) { UI.showStatus(message, 'error'); }
function fail(permanent, message, expired = false) {
  if (permanent) blocked = true;
  inhibitReconnect();
  if (UI.rfb) UI.rfb.disconnect();
  state(expired ? 'expired' : 'error');
  status(message);
}

// Neither saved noVNC settings nor query parameters may redirect credentials to
// another host/path, disable sharing, or enable password-based auto-reconnect.
UI.getSetting = function(name, fallback) {
  if (name === 'host') return window.location.hostname;
  if (name === 'port') return window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  if (name === 'path') return boundPath;
  if (name === 'encrypt') return window.location.protocol === 'https:';
  if (name === 'shared') return true;
  if (name === 'reconnect') return false;
  return originalGetSetting.call(UI, name, fallback);
};
UI.reconnect = () => { inhibitReconnect(); };

async function credentials(signal) {
  const sessionResponse = await fetch('/api/v1/session', {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
  });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || !session.data?.authenticated || typeof session.data.csrfToken !== 'string') {
    const error = new Error('session'); error.expired = true; throw error;
  }
  const response = await fetch(base + 'credentials', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken },
    body: JSON.stringify({ sessionId: context.sessionId, version: context.version }),
  });
  if (!response.ok) {
    const error = new Error('credentials');
    error.expired = [401, 403, 409, 410].includes(response.status);
    throw error;
  }
  const envelope = await response.json();
  const result = envelope.data;
  if (!result || result.version !== context.version || typeof result.password !== 'string' || !/^[\x21-\x7e]{8}$/.test(result.password)) {
    const error = new Error('version'); error.expired = true; throw error;
  }
  return result;
}

function attach(rfb) {
  if (!rfb || attached.has(rfb)) return;
  attached.add(rfb);
  rfb.addEventListener('connect', () => {
    inhibitReconnect();
    if (!closed && !blocked) state('connected');
  });
  rfb.addEventListener('securityfailure', () => {
    blocked = true;
    inhibitReconnect();
    state('error');
  });
}

UI.connect = async function(event) {
  event?.preventDefault();
  if (closed || blocked) {
    state('expired');
    status('桌面会话已失效，请从实例重新打开桌面');
    return;
  }
  if (connecting || UI.rfb) return;
  connecting = true;
  const attempt = ++epoch;
  const controller = new AbortController();
  activeRequest = controller;
  state('connecting');
  UI.updateVisualState('connecting');
  let result;
  try {
    result = await credentials(controller.signal);
    if (closed || blocked || epoch !== attempt || controller.signal.aborted) return;
    // noVNC UI.connect(event, password) passes this only to the new RFB object.
    // A defined argument also prevents noVNC from reading a URL password.
    originalConnect.call(UI, event, result.password);
    if (!UI.rfb) throw new Error('connection');
    supplied.add(UI.rfb);
    attach(UI.rfb);
    inhibitReconnect();
  } catch (error) {
    if (closed || epoch !== attempt || controller.signal.aborted) return;
    fail(Boolean(error.expired), error.expired
      ? '桌面会话或密码版本已失效，请从实例重新打开桌面'
      : '桌面连接暂不可用，请点击连接重试', Boolean(error.expired));
    UI.updateVisualState('disconnected');
    UI.openConnectPanel();
  } finally {
    if (result) result.password = '';
    UI.reconnectPassword = null;
    if (epoch === attempt) { connecting = false; activeRequest = undefined; }
  }
};

// Safe fallback for an RFB instance that did not receive initial credentials.
// Never repeat credential submission for one RFB challenge/instance.
UI.credentials = async function(event) {
  const rfb = event.target;
  if (closed || blocked || supplied.has(rfb) || !event.detail?.types?.includes('password')) {
    fail(true, '桌面认证失败，请从实例重新打开桌面');
    return;
  }
  supplied.add(rfb);
  const controller = new AbortController();
  activeRequest = controller;
  let result;
  try {
    result = await credentials(controller.signal);
    if (!closed && !blocked && UI.rfb === rfb && !controller.signal.aborted) {
      rfb.sendCredentials({ password: result.password });
      attach(rfb);
    }
  } catch (error) {
    if (!controller.signal.aborted) fail(Boolean(error.expired), '桌面认证失败，请重新打开桌面', Boolean(error.expired));
  } finally {
    if (result) result.password = '';
    UI.reconnectPassword = null;
    if (activeRequest === controller) activeRequest = undefined;
  }
};

UI.disconnect = function(...args) {
  epoch++;
  activeRequest?.abort();
  activeRequest = undefined;
  connecting = false;
  inhibitReconnect();
  if (UI.rfb) originalDisconnect.apply(UI, args);
  else { UI.updateVisualState('disconnected'); UI.openConnectPanel(); }
  if (!closed && !blocked) state('disconnected');
};
UI.disconnectFinished = function(event) {
  inhibitReconnect();
  originalDisconnectFinished.call(UI, event);
  if (!closed && !blocked) state('disconnected');
};
window.addEventListener('pagehide', () => {
  closed = true;
  epoch++;
  activeRequest?.abort();
  activeRequest = undefined;
  inhibitReconnect();
  UI.rfb?.disconnect();
});
state(validContext ? 'connecting' : 'expired');
`;
