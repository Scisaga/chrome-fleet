import type { ProxyConfig } from "./api";

type ProxyEndpoint = { scheme: "http" | "https" | "socks5"; host: string; port: number };
const defaultPorts = { http: 80, https: 443, socks5: 1080 };
const invalidAddress = () => new Error("请输入有效的代理地址，例如 http://proxy.example.com:8080");

// Chrome's URI proxy identifiers use scheme://host:port, with HTTP and the
// scheme's standard port as defaults. Credentials remain separate form fields.
export function parseProxyAddress(value: string): ProxyEndpoint {
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(input)) throw invalidAddress();
  const uri = input.includes("://") ? input : `http://${input}`;
  const parts = /^([a-z][a-z\d+.-]*):\/\/([^/?#]+)\/?$/i.exec(uri);
  if (!parts) throw invalidAddress();
  const scheme = parts[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5")
    throw new Error("代理协议支持 HTTP、HTTPS 和无认证 SOCKS5");
  if (parts[2].includes("@")) throw new Error("代理地址只填写服务器地址；认证信息请填写下方的用户名和密码");
  try {
    const url = new URL(uri);
    // Using an HTTP authority also normalizes IDN names and IPv6 for SOCKS5,
    // whose URL scheme is otherwise treated as non-special by WHATWG URL.
    const host = new URL(`http://${url.host}`).hostname;
    const port = url.port ? Number(url.port) : defaultPorts[scheme];
    if (!host || host.length > 253 || !/^[a-z\d.:[\]-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw invalidAddress();
    return { scheme, host, port };
  } catch { throw invalidAddress(); }
}

export function formatProxyAddress(proxy?: Pick<ProxyConfig, "scheme" | "host" | "port">): string {
  if (!proxy?.host || !proxy.port) return "";
  const host = proxy.host.includes(":") && !proxy.host.startsWith("[") ? `[${proxy.host}]` : proxy.host;
  return `${proxy.scheme}://${host}:${proxy.port}`;
}

export function proxyConfigFromForm(data: FormData, previous?: ProxyConfig): ProxyConfig {
  const endpoint = parseProxyAddress(String(data.get("proxyAddress") || ""));
  if (previous?.host) {
    try {
      const old = parseProxyAddress(formatProxyAddress(previous));
      if (old.scheme === endpoint.scheme && old.host === endpoint.host && old.port === endpoint.port)
        endpoint.host = previous.host; // Keep the backend's exact endpoint key and its saved credentials.
    } catch { /* A newly valid endpoint can replace invalid legacy metadata. */ }
  }
  const username = String(data.get("proxyUsername") || "") || undefined;
  const password = String(data.get("proxyPassword") || "") || undefined;
  if (endpoint.scheme === "socks5" && (username || password))
    throw new Error("暂不支持带认证的 SOCKS5，请使用 HTTP/HTTPS 代理或清空认证信息");
  return { enabled: true, ...endpoint, username, password, bypass: String(data.get("bypass") || "") };
}
