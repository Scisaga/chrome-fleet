---
name: chrome-fleet
description: Deploy or connect Chrome Fleet for Codex and Claude Code, then operate the browser belonging to a specified account through its MCP tools. Use for Chrome Fleet setup, connection diagnostics, account targeting, browser tasks, and human desktop handoff.
---

# Chrome Fleet

Use the existing Fleet service and its persistent browser profiles. The bundled Python helper handles installation and transport; use the connected MCP tools for browser work.

- For first use, installation, or MCP registration, read [references/setup.md](references/setup.md). Run the helper from its installed Skill directory so registration does not depend on a source checkout.
- For account selection, browser tasks, or human handoff, read [references/usage.md](references/usage.md). Discover the connected server's actual tool schemas rather than inventing parameters.
- For connection or deployment failures, read [references/troubleshooting.md](references/troubleshooting.md). `doctor` diagnoses an existing connection; `doctor --runtime` additionally creates a temporary empty browser.

Deployment is a separate operation from daily use. Only run `setup` when the user requests deployment or connection configuration. A browser task uses the existing connection; it does not authorize upgrades, migrations, restoration, or unrelated infrastructure changes.

Match the requested account to one unique profile before acting. Website actions return task IDs: query completion and handle human intervention instead of assuming submission succeeded. Preserve a result-unknown task for inspection rather than repeating its actions.

Keep platform credentials on the service host. Do not request or print token contents, SSH secrets, website passwords, or authentication cookies. Browser login and verification use the management desktop. Setup defaults to the existing platform administrator identity; its configured scope also applies to MCP calls.
