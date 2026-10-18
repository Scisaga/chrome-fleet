import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, message, type Profile } from "./api";
import { Button, Field, Icon } from "./components";

export default function VncPasswordSettings({
  profile,
  onChanged,
  notify,
}: {
  profile: Profile;
  onChanged: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [revealed, setRevealed] = useState<{
    password: string;
    version: number;
  }>();
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [profile.id]);
  useEffect(() => {
    generation.current++;
    setRevealed(undefined);
    setRevealing(false);
  }, [profile.id, profile.remoteDesktop?.version]);

  function hide() {
    generation.current++;
    setRevealed(undefined);
    setRevealing(false);
  }
  async function reveal() {
    const request = ++generation.current;
    setRevealing(true);
    setRevealed(undefined);
    try {
      const value = await api<{ password: string; version: number }>(
        `/profiles/${profile.id}/remote-desktop/password/reveal`,
        "POST",
        {},
      );
      if (mounted.current && generation.current === request) setRevealed(value);
    } catch (error) {
      if (mounted.current && generation.current === request)
        notify(message(error), true);
    } finally {
      if (mounted.current && generation.current === request)
        setRevealing(false);
    }
  }
  async function copy() {
    if (!revealed) return;
    let copied = false;
    if (typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(revealed.password);
        copied = true;
      } catch {
        /* HTTP 或浏览器权限可能不支持剪贴板 API。 */
      }
    }
    if (!copied && passwordInput.current) {
      passwordInput.current.focus();
      passwordInput.current.select();
      try {
        copied =
          typeof document.execCommand === "function" &&
          document.execCommand("copy");
      } catch {
        /* 保留选中文本，允许管理员手动复制。 */
      }
    }
    if (mounted.current)
      notify(
        copied
          ? "VNC 密码已复制。"
          : "自动复制不可用，请选中当前 VNC 密码手动复制。",
        !copied,
      );
  }
  async function rotate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const request = ++generation.current;
    setRevealed(undefined);
    setRevealing(false);
    setRotating(true);
    try {
      await api(`/profiles/${profile.id}/remote-desktop/password`, "PUT", {
        password: data.get("password") || undefined,
      });
      if (!mounted.current || generation.current !== request) return;
      hide();
      form.reset();
      notify(
        "VNC 密码已更新并加密保存，可通过「查看 VNC 密码」读取。既有桌面会话已撤销。",
      );
      await onChanged();
    } catch (error) {
      if (mounted.current && generation.current === request)
        notify(message(error), true);
    } finally {
      if (mounted.current) setRotating(false);
    }
  }

  return (
    <section className="panel vnc-password-settings" id="vnc-password-settings">
      <div className="panel-heading">
        <div>
          <h2>远程桌面密码</h2>
          <p>此实例的 VNC 密码已独立加密保存，可按需查看。</p>
        </div>
        <Icon name="key" />
      </div>
      <div className="config-status">
        <span className="small-dot" />
        {profile.remoteDesktop?.passwordConfigured
          ? "已配置独立密码"
          : "尚未配置"}
        {profile.remoteDesktop?.version !==
          profile.remoteDesktop?.appliedVersion && (
          <span className="tag paused">等待生效</span>
        )}
      </div>
      <div className="vnc-password-current">
        <Field
          label="当前 VNC 密码"
          hint={
            revealed
              ? `密码版本 ${revealed.version} · 离开实例设置后将隐藏`
              : "默认隐藏。查看密码不会启动实例。"
          }
        >
          <input
            ref={passwordInput}
            aria-label="当前 VNC 密码"
            readOnly
            autoComplete="off"
            spellCheck={false}
            type={revealed ? "text" : "password"}
            value={revealed?.password || ""}
            placeholder="••••••••"
          />
        </Field>
        <div className="vnc-password-controls">
          {revealed ? (
            <Button icon="key" type="button" onClick={hide}>
              隐藏 VNC 密码
            </Button>
          ) : (
            <Button
              icon="key"
              type="button"
              busy={revealing}
              disabled={rotating || !profile.remoteDesktop?.passwordConfigured}
              onClick={() => void reveal()}
            >
              查看 VNC 密码
            </Button>
          )}
          <Button
            icon="file"
            type="button"
            disabled={!revealed || rotating}
            onClick={() => void copy()}
          >
            复制 VNC 密码
          </Button>
        </div>
      </div>
      <form onSubmit={rotate}>
        <Field
          label="新 VNC 密码"
          hint="恰好 8 个可见 ASCII 字符，留空随机生成；保存后可随时主动查看"
        >
          <input
            name="password"
            type="password"
            minLength={8}
            maxLength={8}
            pattern="[\x21-\x7E]{8}"
            autoComplete="new-password"
            placeholder="输入新密码或留空生成"
          />
        </Field>
        <p className="muted small">
          轮换后旧密码将失效，已有桌面会话会被撤销。该操作不影响网站会话。
        </p>
        <div className="form-actions">
          <Button icon="key" type="submit" busy={rotating}>
            更新桌面密码
          </Button>
        </div>
      </form>
    </section>
  );
}
