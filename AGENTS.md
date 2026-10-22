# chrome-fleet 协作约定

## 手动登录使用普通 Chrome

- 用户要求手动登录、注册或完成验证码、二次验证时，使用普通 Chrome（VNC，`browserMode: "vnc"`），不要使用自动化兼容模式（`browserMode: "automation"`）。
- 打开登录桌面前，确认目标实例实际运行在 VNC 模式；旧实例仍为自动化兼容模式时，先通过平台正常的浏览器模式切换流程切换，再由用户完成登录。
- 自动化兼容模式用于明确需要的网页自动化任务；需要重新登录时，切回普通 Chrome（VNC）。
- 2026-10-22，用户确认 GitHub 改用普通 Chrome（VNC）手动重试后登录成功。详细记录见 [账号登录与会话恢复](docs/session-recovery.md#手动登录模式要求与验证记录)。
