import test from "node:test";
import assert from "node:assert/strict";
import { formatProxyAddress, parseProxyAddress, proxyConfigFromForm } from "./proxy-address";

test("proxy URI input supports explicit schemes, standard ports and HTTP shorthand", () => {
  for (const [input, expected] of [
    [" http://192.168.50.20:8888 ", { scheme: "http", host: "192.168.50.20", port: 8888 }],
    ["proxy.example.test:8080", { scheme: "http", host: "proxy.example.test", port: 8080 }],
    ["https://PROXY.example.test", { scheme: "https", host: "proxy.example.test", port: 443 }],
    ["http://proxy.example.test:80/", { scheme: "http", host: "proxy.example.test", port: 80 }],
    ["socks5://proxy.example.test", { scheme: "socks5", host: "proxy.example.test", port: 1080 }],
    ["http://[2001:db8::1]:8080", { scheme: "http", host: "[2001:db8::1]", port: 8080 }],
    ["[::1]:8888", { scheme: "http", host: "[::1]", port: 8888 }],
    ["socks5://BÜCHER.example:1080", { scheme: "socks5", host: "xn--bcher-kva.example", port: 1080 }],
  ] as const) assert.deepEqual(parseProxyAddress(input), expected);
});

test("invalid proxy identifiers are rejected without echoing credentials", () => {
  for (const input of [
    "", "http://", "ftp://proxy.example.test:21", "socks4://proxy.example.test:1080",
    "http://proxy.example.test:0", "http://proxy.example.test:65536", "http://proxy.example.test:-1",
    "http://proxy.example.test:8.5", "http://proxy.example.test/path", "http://proxy.example.test/./",
    "http://proxy.example.test?query", "http://proxy.example.test#fragment", "http://proxy.example.test?",
    "http://bad host:8080", "http://host\\else:8080", "http://proxy.example.test\n:8080",
    "http://fixture-user:synthetic-secret@proxy.example.test:8080",
    "http://2001:db8::1:8080", "http://[not-ipv6]:8080",
  ]) assert.throws(() => parseProxyAddress(input), error => error instanceof Error && !error.message.includes("synthetic-secret"));
});

test("editing an equivalent endpoint preserves the backend credential key, including legacy IPv6 and host case", () => {
  for (const previous of [
    { enabled: true, scheme: "http", host: "PROXY.EXAMPLE.TEST", port: 8080, hasCredentials: true },
    { enabled: true, scheme: "https", host: "2001:db8::1", port: 443, hasCredentials: true },
    { enabled: true, scheme: "https", host: "[2001:db8::1]", port: 443, hasCredentials: true },
  ]) {
    const form = new FormData();
    form.set("proxyAddress", formatProxyAddress(previous));
    form.set("bypass", "localhost,*.example.test");
    const result = proxyConfigFromForm(form, previous);
    assert.equal(result.host, previous.host);
    assert.equal(result.username, undefined);
    assert.equal(result.password, undefined);
    assert.equal(result.bypass, "localhost,*.example.test");
    assert.ok(!Object.hasOwn(result, "secretRef"));
  }
  const form = new FormData();
  form.set("proxyAddress", "https://other.example.test:443");
  const changed = proxyConfigFromForm(form, { enabled: true, scheme: "http", host: "PROXY.EXAMPLE.TEST", port: 8080, hasCredentials: true });
  assert.deepEqual({ scheme: changed.scheme, host: changed.host, port: changed.port }, { scheme: "https", host: "other.example.test", port: 443 });
});

test("form submission keeps entered authentication separate and rejects authenticated SOCKS5", () => {
  const form = new FormData();
  form.set("proxyAddress", "https://proxy.example.test:8443");
  form.set("proxyUsername", "fixture-user");
  form.set("proxyPassword", " synthetic-password ");
  assert.deepEqual(proxyConfigFromForm(form), {
    enabled: true, scheme: "https", host: "proxy.example.test", port: 8443,
    username: "fixture-user", password: " synthetic-password ", bypass: "",
  });
  form.set("proxyAddress", "socks5://proxy.example.test:1080");
  assert.throws(() => proxyConfigFromForm(form), /SOCKS5/);
  form.delete("proxyUsername");
  form.delete("proxyPassword");
  assert.equal(proxyConfigFromForm(form).scheme, "socks5");
  assert.equal(formatProxyAddress(), "");
});
