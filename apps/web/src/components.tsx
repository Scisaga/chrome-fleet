import { useEffect, useId, useRef, type ReactNode } from "react";

export type IconName =
  | "mcp"
  | "copy"
  | "eye"
  | "eye-off"
  | "edit"
  | "chrome"
  | "users"
  | "grid"
  | "play"
  | "stop"
  | "refresh"
  | "desktop"
  | "settings"
  | "plus"
  | "arrow"
  | "search"
  | "close"
  | "chevron"
  | "check"
  | "clock"
  | "shield"
  | "box"
  | "download"
  | "logout"
  | "layers"
  | "file"
  | "external"
  | "alert"
  | "menu"
  | "key"
  | "terminal"
  | "cpu"
  | "memory";
const paths: Record<IconName, ReactNode> = {
  // Official MCP mark, MIT. Source: modelcontextprotocol/docs@573dc60, favicon.svg.
  // Copyright and permission notice: public/notices/mcp-logo.txt.
  mcp: <>
    <path d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706V16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177" />
    <path d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52" />
    <path d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087V118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822" />
  </>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  "eye-off": <><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.2 4.1M6 6.2A20 20 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5-1.2M10 10a3 3 0 0 0 4 4" /></>,
  edit: <><path d="m16 3 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" /></>,
  memory: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4m5-4v4m5-4v4M7 18v3m5-3v3m5-3v3" /></>,
  chrome: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="M21.17 8H12M3.95 6.06 8.54 14M10.88 21.94 15.46 14" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  refresh: (
    <>
      <path d="M3 11a9 9 0 0 1 15.4-6.3L21 7M21 3v4h-4" />
      <path d="M21 13a9 9 0 0 1-15.4 6.3L3 17M3 21v-4h4" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-5v5" />
    </>
  ),
  settings: (
    <>
      <path
        d="M10.12 3.12Q10.19 2.67 10.64 2.67H13.36Q13.81 2.67 13.88 3.12L14.09 4.48Q14.16 4.92 14.55 5.15L16.66 6.36Q17.05 6.59 17.47 6.43L18.75 5.93Q19.17 5.77 19.39 6.16L20.76 8.52Q20.98 8.91 20.63 9.19L19.56 10.05Q19.21 10.34 19.21 10.79V13.21Q19.21 13.66 19.56 13.95L20.63 14.81Q20.98 15.09 20.76 15.48L19.39 17.84Q19.17 18.23 18.75 18.07L17.47 17.57Q17.05 17.41 16.66 17.64L14.55 18.85Q14.16 19.08 14.09 19.52L13.88 20.88Q13.81 21.33 13.36 21.33H10.64Q10.19 21.33 10.12 20.88L9.91 19.52Q9.84 19.08 9.45 18.85L7.34 17.64Q6.95 17.41 6.53 17.57L5.25 18.07Q4.83 18.23 4.61 17.84L3.24 15.48Q3.02 15.09 3.37 14.81L4.44 13.95Q4.79 13.66 4.79 13.21V10.79Q4.79 10.34 4.44 10.05L3.37 9.19Q3.02 8.91 3.24 8.52L4.61 6.16Q4.83 5.77 5.25 5.93L6.53 6.43Q6.95 6.59 7.34 6.36L9.45 5.15Q9.84 4.92 9.91 4.48Z"
      />
      <circle cx="12" cy="12" r="3.25" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9" />
    </>
  ),
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
  logout: (
    <>
      <path d="M10 4H4v16h6m-1-8h12m-5-5 5 5-5 5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  file: (
    <>
      <path d="M13 3H5v18h14V9Zm0 0v6h6M8 13h8m-8 4h5" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 4H3v17h17v-7" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  key: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="m11.2 11.2 9.8 9.8M17 17l3-3M14 14l3-3" />
    </>
  ),
  terminal: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m6 9 3 3-3 3m6 0h5" />
    </>
  ),
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={name === "mcp" ? "0 0 180 180" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "mcp" ? 12 : name === "chrome" ? 1.7 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Button({
  children,
  icon,
  variant = "default",
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  variant?: "default" | "primary" | "danger" | "ghost";
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`button ${variant} ${props.className || ""}`}
    >
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current
      ?.querySelector<HTMLElement>("input,button,textarea,select")
      ?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const all = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        );
        if (!all?.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          last.focus();
          event.preventDefault();
        }
        if (!event.shiftKey && document.activeElement === last) {
          first.focus();
          event.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-title">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
const labels: Record<string, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  updating: "更新中",
  error: "异常",
  queued: "排队中",
  waiting_for_human: "等待人工",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
  outcome_unknown: "结果未知",
  authenticated: "已验证",
  manually_confirmed: "已人工确认登录",
  bound_unconfirmed: "已绑定，待人工确认",
  unknown: "未检测",
  needs_login: "需要登录",
  needs_verification: "需要验证",
  unsupported: "暂不支持",
  on_demand: "按需启动",
  manual: "手动启动",
  always: "持续运行",
  archived: "已归档",
};
export function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`badge ${value}`}>
      <span className="badge-dot" />
      {label || labels[value] || value}
    </span>
  );
}
export function Empty({
  title,
  children,
  icon = "box",
}: {
  title: string;
  children?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Notice({
  children,
  warning,
}: {
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <div className={`notice ${warning ? "warning" : ""}`}>
      <Icon name={warning ? "alert" : "shield"} />
      <div>{children}</div>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Data({ value }: { value: unknown }) {
  return (
    <pre className="data-block">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
