# DSH Superagent Review

DSH Superagent Review 是面向受控交付场景的 `dsh-superagent` 独立发行版。它在需求接收、只读评估、Worker 执行和 Git 交付能力之上加入人工复核模式，并与 [Gatehouse](https://github.com/AIR-DUSTER1/dsh-gatehouse) 组成完整的审批与执行闭环。

> **当前仓库**：[AIR-DUSTER1/dsh-superagent-review](https://github.com/AIR-DUSTER1/dsh-superagent-review)<br>
> **技术包名**：`dsh-superagent`，为兼容 DSH 插件体系保持不变。

## 核心能力

- **Review 模式**：评估通过只生成 Proposal，不创建 Ticket、worktree 或 PR。
- **受控执行**：只有 Gatehouse 人工批准并签发一次性 `ApprovalGrant` 后才执行。
- **工作区隔离**：多工作区、多仓库独立路由，线程、游标、健康状态和去重键互不干扰。
- **执行回执**：回传开始、完成和失败状态，并继续负责 Git commit、PR 与飞书通知。
- **中文优先**：默认用简体中文解释原因、风险和排期，代码、命令、路径和标识符保持原样。

## 与 Gatehouse 的关系

```text
飞书 / GitHub / 内网 Git
  → DSH Superagent Review：接收需求、只读评估、生成 Proposal
  → Gatehouse：人工复核、批准、排期、发送一次性 Grant
  → DSH Superagent Review：校验 Grant、创建 Ticket、执行并交付 PR
  → Gatehouse：展示执行回执、PR 和审计记录
```

DSH Superagent Review 不代替人工做审批决定；Gatehouse 不直接操作 Git、worktree 或 PR。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.7.0` 或兼容版本
- DeepSeek Harness `^0.2.1-alpha.2`
- GitHub CLI，并已登录具有目标仓库访问权限的机器人账号
- 可选：飞书 / Lark 机器人 CLI

## 安装与加载

```powershell
pnpm install
pnpm build
```

构建完成后按 DSH 插件方式加载本仓库。本地开发 profile 可使用 `link:<当前仓库绝对路径>`；首次接入建议阅读 [SETUP.md](SETUP.md) 和 [部署文档](docs/006-deployment.md)。

## 回复语言

在 DSH 管理面板的 `设置 → 评估 → 回复语言` 中选择输出语言，默认是 **简体中文**。该设置影响调研结论、Proposal、风险说明、测试计划、通知、PR 描述和评论。

## 连接 Gatehouse

### 1. 配置 DSH profile

在 `cordis.patch.yml` 中配置 Web 服务和控制台连接：

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

`consoleUrl` 指向 Gatehouse。两个 secret 必须同时配置，且不能提交到 Git。

### 2. 开启人工复核

在 DSH 管理面板的 `Settings → Eval` 中选择“人工复核 / Review”。该模式下，即使是显式请求，也会先完成评估并生成 Proposal。

### 3. 配置 Gatehouse

在 Gatehouse `.env` 中填写相同密钥：

```dotenv
PLUGIN_MODE=http
PLUGIN_BASE_URL=http://127.0.0.1:3082
PLUGIN_EVENT_SECRET=<与 consoleEventSecret 相同>
PLUGIN_SHARED_SECRET=<与 consoleSharedSecret 相同>
```

Gatehouse 的启动、工作区接入和审批操作见其 [README](https://github.com/AIR-DUSTER1/dsh-gatehouse#readme)。

## Provider 支持范围

| Provider | 当前能力 |
| --- | --- |
| GitHub / GitHub Enterprise | 多实例轮询、评论、CI 观察、执行环境与 PR 交付 |
| GitLab / Gitea / Bitbucket / 裸 Git | 通用执行目标：连接、校验、描述、路由和 Git 交付；不包含原生 Issue/MR 轮询 |

私仓需要显式配置主机允许列表：

```dotenv
DSH_SUPERAGENT_ALLOW_PRIVATE_REPOSITORY_HOSTS=true
DSH_SUPERAGENT_REPOSITORY_HOST_ALLOWLIST=git.internal.example
```

凭据引用只支持 `env:NAME` 和 `file:PATH`。`system:` 凭据与 `custom_ca_ref` 会明确拒绝，不会静默忽略。

## 文档

- [初始化向导](SETUP.md)
- [部署与配置](docs/006-deployment.md)
- [授权机制](docs/002-authorization.md)
- [执行模型](docs/003-execution.md)
- [架构](docs/007-architecture.md)
- [全部文档](docs/)

## 来源与许可

本项目由 **AIR-DUSTER1** 独立维护：

<https://github.com/AIR-DUSTER1/dsh-superagent-review>

本项目来源于开源项目 **dsh-superagent**：

<https://github.com/deepseek-ai/dsh-superagent-prototype>

DSH Superagent Review 不是 DeepSeek 官方仓库或官方产品。上游版权、MIT License、NOTICE 和第三方依赖许可继续适用，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。