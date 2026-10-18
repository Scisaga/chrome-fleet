import { Field } from "./components";
import type { ProxyConfig } from "./api";
import "./proxy-fields.css";

export default function ProxyFields({ address, onAddressChange, proxy }: {
  address: string;
  onAddressChange: (value: string) => void;
  proxy?: ProxyConfig;
}) {
  const socks5 = /^socks5:\/\//i.test(address.trim());
  return (
    <div className="proxy-fields">
      <Field label="代理地址" hint="支持 http://、https://、socks5://；省略协议时使用 HTTP。">
        <input
          name="proxyAddress"
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          required
          maxLength={2048}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="http://proxy.example.com:8080"
        />
      </Field>
      <Field label="绕过规则" hint="以逗号分隔的域名或主机名">
        <input name="bypass" defaultValue={proxy?.bypass} placeholder="可选" />
      </Field>
      {!socks5 && <div className="proxy-auth-fields">
        <Field label="代理用户名" hint={proxy?.hasCredentials ? "同一代理留空保留现有凭证" : undefined}>
          <input name="proxyUsername" autoComplete="off" placeholder="可选" />
        </Field>
        <Field label="代理密码">
          <input name="proxyPassword" type="password" autoComplete="new-password" placeholder={proxy?.hasCredentials ? "已设置，同一代理留空保留" : "可选"} />
        </Field>
      </div>}
    </div>
  );
}
