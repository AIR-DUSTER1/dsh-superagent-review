# DSH Superagent Review

> **Project name:** DSH Superagent Review  
> **Maintainer:** [AIR-DUSTER1](https://github.com/AIR-DUSTER1)  
> **Current repository:** [AIR-DUSTER1/dsh-superagent-review](https://github.com/AIR-DUSTER1/dsh-superagent-review)  
> **Technical package/bundle name:** `dsh-superagent` (kept for DSH compatibility)

DSH Superagent Review 是一个面向受控交付场景的 **dsh-superagent 独立发行版**。它在原项目的需求接收、只读评估、Worker 执行、Git 与 PR 交付能力之上，增加了人工复核模式，并与 [Gatehouse](https://github.com/AIR-DUSTER1/dsh-gatehouse) 审批控制台组成完整闭环。

> **来源声明**  
> 当前项目由 **AIR-DUSTER1** 独立维护：  
> [https://github.com/AIR-DUSTER1/dsh-superagent-review](https://github.com/AIR-DUSTER1/dsh-superagent-review)  
> 本项目基于开源项目 **dsh-superagent** 的官方仓库修改：  
> [https://github.com/deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)  
> DSH Superagent Review 不是 DeepSeek 官方仓库或官方产品。上游 README 中的研究原型声明、MIT License、原作者版权和第三方依赖许可继续适用。

## 工作方式

```text
飞书 / GitHub / 内网 Git 仓库任务
  ↓
DSH Superagent Review：接收需求 + 只读评估 + 生成 Proposal
  ↓  HMAC 事件
Gatehouse：人工复核 + 批准 + 排期 + 审计
  ↓  HMAC 决策 / 执行命令
DSH Superagent Review：校验 ApprovalGrant + 创建 Ticket + Worker 执行
  ↓
Git commit / Pull Request / 飞书回执
  ↓
execution.started / execution.finished / execution.failed
```

核心不变量：

- `review` 模式下，评估通过只生成 Proposal，不创建 Ticket、worktree 或 PR。
- 人工批准前不会运行命令、修改文件、清理订阅或产生其他代码执行副作用。
- 收到需求后先向发起人解释浅显原因并告知已记录、已移交开发；批准后再通知开发开始时间。
- ApprovalGrant 绑定 `requirement_hash`、`scope_hash`、`workspace_binding_hash`、排期和过期时间。
- Gatehouse 在批准命令中下发 canonical `grant_id`；执行侧不得生成第二枚 Grant ID。
- Grant 在执行前原子消费，重复请求使用同一 `execution_id`，不会重复创建 Worker。
- DSH Superagent Review 不自行判断人工审批结果；Gatehouse 不直接操作 Git 或 PR。

## 本发行版新增内容

- `eval.mode = review`。
- Proposal、ApprovalGrant、执行状态和 console event outbox 持久化。
- Console 事件 HMAC API。
- 决策 API：`POST /orchestrator/api/proposals/:id/decision`。
- 改期 API：`POST /orchestrator/api/proposals/:id/reschedule`。
- 撤回 API：`POST /orchestrator/api/proposals/:id/withdraw`。
- 执行 API：`POST /orchestrator/api/executions`。
- 执行前重新校验需求哈希、范围哈希、排期和过期时间。
- `Engine.executeProposal`：只在 Grant 验证通过后创建 Ticket。
- 审批排期通知会说明该时间是开发开始时间，不是完成时间，并提示仍需测试和部署。
- 改期会更新活动 Grant 并再次通知发起人；撤回会吊销 Grant、回到待复核并阻止旧授权执行。
- Worker `failed` / `blocked` 报告回传 `execution.failed`。
- gatehouse 风格的 Review 模式配置入口和双语提示。
- Gatehouse 签名同步多个工作区、多个仓库和版本化仓库描述。
- 同一 Source kind 支持多个实例；线程键、轮询游标、健康状态和去重键按实例隔离。
- Proposal 事件升级为 `2.0`，携带工作区、仓库、路由依据和绑定哈希；仍接受 `1.0` 历史事件。
- 原生 GitHub 事件确定性路由；飞书/人工任务按已确认仓库描述做确定性语义路由，低置信度强制人工确认。
- 全局统计由 Gatehouse 聚合；DSH 提供仓库发现、README 摘要和当前配置模型生成描述。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.7.0` 或更高兼容版本
- DeepSeek Harness `^0.2.1-alpha.2`
- GitHub CLI 与具有目标仓库写入权限的机器人账号
- 可选：Feishu / Lark 机器人 CLI

## 安装

```powershell
cd D:\code\dsh-superagent-review
pnpm install
pnpm typecheck
pnpm build
```

## 回复语言

在 `设置 → 评估 → 回复语言` 中选择 Agent 面向人的输出语言，默认是 **简体中文**。该设置影响调研结论、Proposal、风险说明、验证计划、通知、PR 描述和评论；代码、命令、路径、标识符和引用原文保持原样。

## 与 Gatehouse 联调

### 1. 配置 DSH Superagent Review

在 DSH profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082

- id: dsh-superagent
  config:
    stateDir: <absolute state directory>
    consoleUrl: http://127.0.0.1:8787
    consoleEventSecret: <event secret>
    consoleSharedSecret: <command secret>
```

`consoleUrl` 指向 Gatehouse。设置后必须同时提供两个 secret，否则启动检查会拒绝配置。

### 2. 打开 review 模式

在 DSH Superagent Review 管理面板的 **Settings → Eval** 中选择：

```text
人工复核 / Review
```

该模式下，显式请求也会经过完整评估并生成 Proposal，而不是直接创建 Ticket。

### 3. 配置 Gatehouse

在 Gatehouse `.env` 中配置：

```dotenv
PLUGIN_MODE=http
PLUGIN_BASE_URL=http://127.0.0.1:3082
PLUGIN_EVENT_SECRET=<与 consoleEventSecret 相同>
PLUGIN_SHARED_SECRET=<与 consoleSharedSecret 相同>
```

Gatehouse 启动：

```powershell
cd D:\code\dsh-gatehouse
pnpm install
pnpm dev
```

### 4. 执行方向

DSH Superagent Review → Gatehouse：

- `proposal.created`（事件 `2.0`）
- `proposal.superseded`
- `execution.started`
- `execution.finished`
- `execution.failed`

Gatehouse → DSH Superagent Review：

- 审批决策。
- 到期执行命令。
- 工作区同步、仓库校验、描述生成和人工改派。
- 两侧均使用 HMAC、timestamp、nonce 和 idempotency key。

### 5. 工作区与多仓库

Gatehouse 是仓库和工作区配置的控制面。每次确认仓库描述后，Gatehouse 调用：

```text
POST /orchestrator/api/workspaces/sync
```

DSH 保存最后一份已确认配置并重启应用。配置项包括：

- `workspace_id`、`repository_id`、Provider、仓库标识和默认分支。
- `credential_ref`：只保存引用，不保存 Token；支持 `env:NAME`、`file:PATH`，当前用于只读仓库发现。Git Push/PR 继续使用 DSH 运行账户已配置的 `gh`/Git 凭据。
- 仓库能力、路由关键词、排除项、描述版本和描述哈希。
- 每个仓库独立 `source_instance_id`，因此同名 Issue/PR 编号不会冲突。

内网地址默认禁止。需要内网 Git 服务时显式设置：

```dotenv
DSH_SUPERAGENT_ALLOW_PRIVATE_REPOSITORY_HOSTS=true
DSH_SUPERAGENT_REPOSITORY_HOST_ALLOWLIST=git.internal.example
```

### Provider 能力边界

| Provider | 当前能力 |
| --- | --- |
| GitHub / GitHub Enterprise | 多实例事件轮询、评论、CI 观察、执行环境与 PR 交付；GHE 需要 `gh` CLI 已登录对应主机并配置主机允许列表 |
| GitLab / Gitea / Bitbucket / 裸 Git | 通过通用执行 Target 接入：可连接、校验、生成描述、路由和执行 Git 交付；本版本不轮询原生 Issue/MR 事件。原生 Provider 事件属于后续增量 |

通用执行 Target 不伪造原生事件支持。相关任务来源应使用飞书、Webhook 或人工录入，并由仓库描述路由。首版只解析 `env:` 与 `file:` 凭据引用；`system:` 凭据存储和 `custom_ca_ref` 会明确拒绝，不会静默忽略。

## 常用命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm check  # typecheck + test + build
```

本次审批桥接相关测试：

```powershell
pnpm exec vitest run tests/approval-bridge.spec.ts tests/core-engine.spec.ts tests/policy.spec.ts tests/http.spec.ts tests/panel-settings.spec.tsx tests/locales.spec.ts
```

工作区、路由与描述生成测试：

```powershell
pnpm exec vitest run tests/workspace-service.spec.ts tests/workspace-routing.spec.ts tests/registry.spec.ts tests/bundle-patch.spec.ts
```

> 完整仓库测试仍包含依赖 POSIX `sh`、`sleep`、symlink 和 Unix mode bits 的上游用例；在 Windows 环境中这些既有测试可能失败。Windows 下请以 TypeScript、构建和审批相关测试结果作为本发行版的验收依据。

## 文档

- [部署与配置](docs/006-deployment.md)
- [授权机制](docs/002-authorization.md)
- [架构](docs/007-architecture.md)
- [执行模型](docs/003-execution.md)
- [上游来源](https://github.com/deepseek-ai/dsh-superagent-prototype)

## License

本项目沿用上游 [MIT License](LICENSE)。同时保留上游项目来源、版权和许可声明。
