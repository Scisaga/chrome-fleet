import { useId, useRef, useState } from "react";
import { Button, Icon, Notice, type IconName } from "./components";
import { mcpGroups, type McpToolMode } from "./mcp-catalog";

const groupIcons: Record<string, IconName> = {
  profiles: "grid", jobs: "terminal", manual: "desktop",
  sessions: "file", backups: "layers", updates: "refresh",
};
const modeLabels: Record<McpToolMode, string> = {
  all: "通用", automation: "自动化模式", conditional: "按模式处理",
};
const toolCount = mcpGroups.reduce((count, group) => count + group.tools.length, 0);

export default function McpPage({ origin, notify }: {
  origin: string;
  notify: (text: string, error?: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const endpointId = useId();
  const endpointInput = useRef<HTMLInputElement>(null);
  const endpoint = new URL("/mcp", origin).href;
  const query = search.trim().toLowerCase();
  const groups = mcpGroups.map((group) => ({ ...group, tools: group.tools.filter((tool) =>
    [group.title, group.description, tool.name, tool.description, tool.scope].join(" ").toLowerCase().includes(query),
  ) })).filter((group) => group.tools.length > 0);
  const matchingCount = groups.reduce((count, group) => count + group.tools.length, 0);
  const columns = [0, 1].map((column) => groups.filter((_, index) => index % 2 === column))
    .filter((column) => column.length > 0);

  async function copyEndpoint() {
    let copied = false;
    if (typeof navigator.clipboard?.writeText === "function") {
      try { await navigator.clipboard.writeText(endpoint); copied = true; } catch { /* Use the LAN HTTP fallback below. */ }
    }
    if (!copied && endpointInput.current) {
      endpointInput.current.focus();
      endpointInput.current.select();
      try { copied = typeof document.execCommand === "function" && document.execCommand("copy"); } catch { /* Leave the address selected. */ }
    }
    notify(copied ? "MCP 服务地址已复制。" : "地址已选中，请手动复制。", !copied);
  }

  return <div className="mcp-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow">MODEL CONTEXT PROTOCOL</div>
        <h1>MCP <span className="heading-pill">{toolCount} 个工具</span></h1>
        <p>让 AI 客户端管理 Chrome 实例、查询任务，并在自动化模式下操作网页。</p>
      </div>
      <span className="mcp-heading-icon"><Icon name="mcp" size={26} /></span>
    </div>

    <section className="panel mcp-connection" aria-labelledby="mcp-connection-title">
      <div className="panel-heading">
        <div><h2 id="mcp-connection-title">连接 MCP 服务</h2><p>使用平台内置的 HTTP 入口，在 MCP 客户端填写以下连接信息。</p></div>
        <span className="tag verified">Streamable HTTP</span>
      </div>
      <label className="mcp-endpoint-label" htmlFor={endpointId}>MCP 服务地址</label>
      <div className="mcp-endpoint-controls">
        <input id={endpointId} ref={endpointInput} aria-label="MCP 服务地址" type="url" readOnly spellCheck={false} value={endpoint} onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" icon="copy" onClick={() => void copyEndpoint()}>复制地址</Button>
      </div>
      <div className="mcp-auth-info">
        <span>认证方式 <strong>Bearer Token</strong></span>
        <code>Authorization: Bearer &lt;平台访问令牌&gt;</code>
      </div>
      <p className="mcp-connection-hint">使用项目 <code>secrets/admin-token</code> 中的令牌，在客户端填写。可访问的功能和实例由令牌权限决定。</p>
    </section>

    <Notice>新建实例默认为 VNC。网页自动化和会话导入导出，需要先在实例设置中切换为自动化模式。Google 账号绑定与人工登录确认仍在管理界面完成。</Notice>

    <div className="mcp-catalog-toolbar">
      <div><h2>功能一览</h2><span>{query ? `找到 ${matchingCount} 个工具` : `${mcpGroups.length} 类功能 · ${toolCount} 个工具`}</span></div>
      <label className="mcp-search"><Icon name="search" size={17} /><input aria-label="搜索 MCP 功能" type="search" placeholder="搜索功能或工具名称…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    </div>
    {groups.length ? <div className="mcp-catalog-grid">
      {columns.map((column, index) => <div className="mcp-catalog-column" key={index}>
        {column.map((group) => <section className="panel mcp-tool-group" key={group.id} aria-labelledby={`mcp-group-${group.id}`}>
          <div className="panel-heading">
            <div><h2 id={`mcp-group-${group.id}`}><Icon name={groupIcons[group.id]} size={18} />{group.title}<span className="mcp-group-count">{group.tools.length}</span></h2><p>{group.description}</p></div>
          </div>
          <ul className="mcp-tool-list">
            {group.tools.map((tool) => <li key={tool.name} data-mcp-tool={tool.name}>
              <div className="mcp-tool-title"><code>{tool.name}</code><span className={`mcp-tool-mode ${tool.mode}`}>{modeLabels[tool.mode]}</span></div>
              <p>{tool.description}</p>
              <span className="mcp-tool-scope">所需权限 <code>{tool.scope}</code></span>
            </li>)}
          </ul>
        </section>)}
      </div>)}
    </div> : <div className="panel mcp-empty" role="status"><Icon name="search" /><p>没有匹配的功能，请尝试其他关键词。</p><Button type="button" onClick={() => setSearch("")}>清空搜索</Button></div>}

    <section className="panel mcp-usage" aria-labelledby="mcp-usage-title">
      <div className="panel-heading"><h2 id="mcp-usage-title">调用与结果</h2><Icon name="terminal" size={18} /></div>
      <p>启动、网页操作、备份和更新等操作会返回 <code>jobId</code>。使用 <code>jobs_get</code> 查询进度和结果；断开 MCP 连接不会取消已经提交的任务。</p>
      <p>任务进入 <code>waiting_for_human</code> 后，通过 <code>manual_session_open</code> 打开人工桌面处理验证，结束人工会话后再按任务状态继续。工具清单展示全部功能，执行时会检查权限、实例范围和浏览器模式。</p>
    </section>
  </div>;
}
