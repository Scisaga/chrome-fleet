export type McpToolScope =
  | "read"
  | "manage"
  | "automate"
  | "session:read"
  | "session:write"
  | "backup"
  | "update";

export type McpToolMode = "all" | "automation" | "conditional";

export interface McpTool {
  name: string;
  description: string;
  scope: McpToolScope;
  mode: McpToolMode;
}

export interface McpGroup {
  id: string;
  title: string;
  description: string;
  tools: readonly McpTool[];
}

export const mcpGroups: readonly McpGroup[] = [
  {
    id: "profiles",
    title: "实例与配置",
    description: "查询和管理独立 Chrome 实例、运行策略及代理配置。",
    tools: [
      { name: "profiles_list", description: "分页查询实例及脱敏状态。", scope: "read", mode: "all" },
      { name: "profiles_get", description: "查看实例详情、账号映射与资源占用。", scope: "read", mode: "all" },
      { name: "profiles_create", description: "创建默认停止的 VNC 实例；自动化模式需在实例设置中切换。", scope: "manage", mode: "all" },
      { name: "profiles_start", description: "提交启动任务，并通过任务编号查询结果。", scope: "manage", mode: "all" },
      { name: "profiles_stop", description: "提交停机任务并保留会话；强制停止可能丢失未完成操作。", scope: "manage", mode: "all" },
      { name: "profiles_restart", description: "提交受控重启任务，保留用户目录。", scope: "manage", mode: "all" },
      { name: "profiles_runtime_policy_set", description: "设置启动策略、自动唤起及空闲超时。", scope: "manage", mode: "all" },
      { name: "profiles_proxy_get", description: "查看脱敏代理配置与已应用版本。", scope: "read", mode: "all" },
      { name: "profiles_proxy_set", description: "设置或禁用实例代理；认证凭据只接受已有 secretRef。", scope: "manage", mode: "all" },
      { name: "profiles_proxy_test", description: "提交真实浏览器 HTTP/HTTPS 出口检测任务。", scope: "automate", mode: "automation" },
      { name: "profiles_vnc_password_set", description: "使用已有 secretRef 轮换 VNC 密码，并撤销旧桌面会话。", scope: "manage", mode: "all" },
    ],
  },
  {
    id: "jobs",
    title: "任务与网页操作",
    description: "通过持久化队列执行声明式网页步骤，查询结果或处理任务。",
    tools: [
      { name: "jobs_submit", description: "提交一组声明式网页步骤，返回任务编号。", scope: "automate", mode: "automation" },
      { name: "jobs_get", description: "查看任务进度、结果、人工处理需求与错误摘要。", scope: "read", mode: "all" },
      { name: "jobs_cancel", description: "请求取消任务；已经发生的网页操作无法撤回。", scope: "automate", mode: "all" },
      { name: "jobs_resume", description: "人工完成验证后恢复等待任务，不重放结果未知的操作。", scope: "automate", mode: "all" },
      { name: "browser_pages_list", description: "提交页面列表查询，随后通过任务读取结果。", scope: "automate", mode: "automation" },
      { name: "browser_navigate", description: "提交指定页面的导航任务。", scope: "automate", mode: "automation" },
      { name: "browser_click", description: "通过页面定位器提交点击任务。", scope: "automate", mode: "automation" },
      { name: "browser_fill", description: "提交普通表单填写；网站密码与验证请在人工桌面完成。", scope: "automate", mode: "automation" },
      { name: "browser_extract", description: "提交页面文本提取，随后通过任务读取结果。", scope: "automate", mode: "automation" },
      { name: "browser_screenshot", description: "提交截图任务并返回产物引用；人工登录期间不允许截图。", scope: "automate", mode: "automation" },
    ],
  },
  {
    id: "manual",
    title: "人工接管与身份检测",
    description: "申请受保护桌面租约，或在自动化模式下检测站点账号身份。",
    tools: [
      { name: "accounts_check", description: "提交站点身份检测；Cookie 存在不代表已登录。", scope: "automate", mode: "automation" },
      { name: "manual_session_open", description: "申请限时人工租约，获取同一 Chrome 的受保护桌面入口。", scope: "automate", mode: "all" },
      { name: "manual_session_close", description: "结束人工接管、撤销桌面权限并释放租约。", scope: "automate", mode: "all" },
    ],
  },
  {
    id: "sessions",
    title: "会话导入导出",
    description: "在自动化模式下，通过授权的加密产物迁移 Cookie 和存储状态。",
    tools: [
      { name: "cookies_export", description: "提交 Cookie 导出任务，只返回加密产物引用。", scope: "session:read", mode: "automation" },
      { name: "cookies_import", description: "从授权产物导入 Cookie；导入成功不代表登录成功。", scope: "session:write", mode: "automation" },
      { name: "storage_state_export", description: "提交存储状态导出任务，不返回状态正文。", scope: "session:read", mode: "automation" },
      { name: "storage_state_import", description: "从授权产物导入存储状态，支持合并或覆盖指定范围。", scope: "session:write", mode: "automation" },
    ],
  },
  {
    id: "backups",
    title: "备份与产物",
    description: "保存完整加密快照、恢复会话，或查看任务产物的元数据。",
    tools: [
      { name: "profiles_backup", description: "提交停机一致性的完整加密快照任务。", scope: "backup", mode: "all" },
      { name: "profiles_restore", description: "恢复匹配版本的完整快照并覆盖本地状态，要求实例停止。", scope: "backup", mode: "all" },
      { name: "artifacts_get", description: "查看授权产物元数据，不下载文件正文。", scope: "read", mode: "all" },
    ],
  },
  {
    id: "updates",
    title: "浏览器版本与更新",
    description: "查询版本、检查官方更新，并提交受控升级或配对回滚任务。",
    tools: [
      { name: "browser_versions_list", description: "查询当前、候选及已验证的 Chrome 版本。", scope: "read", mode: "all" },
      { name: "browser_updates_check", description: "提交官方版本检查与兼容验证任务。", scope: "update", mode: "all" },
      { name: "browser_updates_apply", description: "提交已验证镜像的受控升级；VNC 实例当前会延后处理。", scope: "update", mode: "conditional" },
      { name: "browser_updates_rollback", description: "恢复升级前配对的镜像与会话快照，覆盖恢复点之后的本地状态。", scope: "update", mode: "all" },
    ],
  },
];
