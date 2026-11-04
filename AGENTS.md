# DSH Superagent Review 仓库协作规范

本文件适用于整个仓库，是所有 agent、贡献者和维护者的协作约定。修改代码、测试、提交或发布前必须先阅读并遵守；若用户当前明确指令与本文件冲突，以用户指令为准，但不得绕过安全边界。

## 1. 项目定位

DSH Superagent Review 是独立维护的 `dsh-superagent` 发行版，不是 DeepSeek 官方仓库或官方产品。

- 当前仓库：`https://github.com/AIR-DUSTER1/dsh-superagent-review`
- 技术包名：`dsh-superagent`，为兼容 DSH 插件体系保持不变
- 上游来源：`https://github.com/deepseek-ai/dsh-superagent-prototype`
- 必须保留上游版权、MIT License、NOTICE 和第三方依赖许可
- README、文档和页面中必须明确当前维护仓库，不得把本发行版描述为官方产品

## 2. 核心职责与不可破坏的边界

```text
飞书 / GitHub / 内网 Git
  → DSH Superagent Review：接收需求、只读评估、生成 Proposal
  → Gatehouse：人工复核、批准、排期、发送一次性 Grant
  → DSH Superagent Review：校验 Grant、创建 Ticket、执行并交付 PR
  → Gatehouse：展示执行回执、PR 和审计记录
```

### 必须保持

1. `review` 模式下只生成 Proposal，不创建 Ticket、worktree、分支或 PR。
2. 人工批准前不得运行会修改文件、仓库、订阅或外部系统的命令。
3. 执行前必须校验 Gatehouse 下发的 canonical `grant_id`，不得在执行侧生成第二枚 Grant ID。
4. Grant 必须绑定 `requirement_hash`、`scope_hash`、`workspace_binding_hash`、排期和过期时间。
5. Grant 必须在执行前原子消费；重放或重复请求不得重复创建 Worker。
6. Gatehouse 事件和命令必须校验 HMAC、timestamp、nonce 与 idempotency key。
7. 工作区、仓库、Source 实例、线程、游标和去重键必须保持隔离。
8. 外部副作用必须通过事务和 outbox/effects 调度，不能在数据库事务内直接执行网络请求。
9. 不伪造 Provider 能力；未实现的 Issue/MR 轮询必须在文档和界面中明确标记。
10. 面向人的输出默认使用简体中文；技术标识符、命令、路径和引用原文保持原样。

## 3. 技术栈与目录

- Node.js：`^22.19.0` 或 `>=24.0.0`
- pnpm：`11.7.0` 或兼容版本
- TypeScript strict 模式，构建使用 `tsdown`
- 测试使用 Vitest 与 jsdom
- 运行形态：DeepSeek Harness 插件 / bundle
- 本地状态：DSH `stateDir` 下的 SQLite 数据与运行文件

```text
src/core/        领域模型、Engine、策略与持久化接口
src/app/         Runtime、启动、effects、outbox、notices 和调度
src/executor/    Ticket 执行、Worker 和交付
src/sources/     GitHub、飞书和通用 Source
src/client/      DSH Web 管理面板
src/infra/       基础设施和存储适配
tests/           单元、集成和契约测试
prompts/         Agent 提示词
skills/          内置技能
locale/          多语言资源
docs/            已落地、可交付的技术文档
scripts/         安装、运行和诊断脚本
lib/             构建产物，不提交
plans/           本地计划文档，仅保存在开发机，不纳入 Git
```

领域规则优先进入 `src/core`；路由、适配器和 UI 不得各自复制审批、Grant、工作区、幂等或策略判断。

## 4. 本地准备

```powershell
pnpm install
pnpm typecheck
pnpm build
```

开发 DSH 面板或管理 API 时，应将当前仓库链接到隔离的 DSH profile；不要把真实凭据、真实状态目录或 profile 文件复制到仓库。

## 5. 实现约定

### TypeScript 与边界

- 保持 TypeScript strict 通过，不使用 `any` 逃避类型检查。
- 外部输入必须使用 Zod 或现有 schema 在边界校验。
- 领域规则放在 Engine、Policy、Executor 或对应服务中，不放在 CLI 字符串拼接或 UI 组件里。
- 外部 API、Source、CLI 和 Webhook 的错误必须转换为可读业务错误，不泄露密钥、token、Cookie、完整路径或内部堆栈。
- 新增或修改持久化结构时必须提供迁移、兼容读取和回滚说明。
- 新增配置项时必须同步 schema、默认值、面板、locale、文档和测试。

### Review 与审批

- Proposal 必须携带需求、范围、测试计划、风险和工作区绑定信息。
- 审批意见可以为空；不要重新引入必填限制。
- 自审拦截、哈希变化、Grant 过期、Grant 重放和排期变更必须有回归测试。
- 改期必须使旧排期同步失效；撤回必须吊销 Grant 并回到待复核。
- 批准后的通知必须说明排期时间是“开发开始时间”，不是完成时间，并提示后续仍需测试与部署。
- 收到报错类需求时，对非技术用户给出浅显原因，说明问题已记录并移交开发，不承诺未经审批的执行。

### 工作区与 Source

- 每个 Source 实例使用独立 `source_instance_id`；线程键、轮询游标、健康状态和去重键不得跨实例共享。
- GitHub 原生事件使用确定性仓库路由；无明确仓库的任务才允许语义路由。
- 低置信度、候选冲突或描述不完整时必须进入人工确认。
- 工作区配置使用版本和哈希校验；配置或仓库绑定变化必须使旧 Grant 失效。
- 凭据只保存 `env:` 或 `file:` 引用；`system:` 和 `custom_ca_ref` 明确拒绝。
- 内网仓库必须经过主机允许列表和地址安全校验，防止 SSRF 与跨域重定向。

### 客户端与交互

- 使用现有 DSH client 组件和设计体系，不引入冲突 UI 框架。
- 页面必须有 loading、empty、error 和成功反馈。
- 高风险操作需要明确确认和可读结果。
- 权限与工作区限制不能只依赖前端隐藏；服务端必须再次校验。
- 默认中文文案应面向不懂技术的用户，避免内部术语堆砌和空泛“AI 风格”文案。

### 安全

- 不记录密码、Secret、Token、Authorization Header、Cookie 或完整凭据。
- 不把真实姓名、邮箱、飞书 ID、仓库 Token 或机器人账号写入测试和文档。
- HMAC 校验必须覆盖时间窗口、nonce 防重放和 idempotency。
- 不使用字符串拼接构造外部命令；用户输入不得直接进入 Shell。
- 不重置、删除或覆盖真实 DSH 状态目录、SQLite 数据和用户配置。
- 测试必须使用临时目录、临时数据库和可清理的 profile。

## 6. 测试与完成标准

任何行为变更至少满足：

1. 有对应的单元、集成或契约测试。
2. 修复 bug 时先补能复现问题的测试。
3. 外部输入、错误路径、重试、幂等和权限边界有覆盖。
4. 不删除测试、放宽断言、跳过失败用例或吞掉异常。

常用质量门禁：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

审批与 Bridge 定向测试：

```powershell
pnpm exec vitest run tests/approval-bridge.spec.ts tests/core-engine.spec.ts tests/policy.spec.ts tests/http.spec.ts tests/panel-settings.spec.tsx tests/locales.spec.ts
```

工作区、路由与配置同步定向测试：

```powershell
pnpm exec vitest run tests/workspace-service.spec.ts tests/workspace-routing.spec.ts tests/registry.spec.ts tests/bundle-patch.spec.ts
```

Windows 环境说明：

- 上游完整测试包含依赖 POSIX `sh`、`sleep`、tmux、symlink 和 Unix mode bits 的用例，可能失败。
- 不得把平台限制导致的失败描述为“全部通过”。
- 至少运行 TypeScript、定向测试和生产构建，并在交付中写明未覆盖风险。
- 支持 POSIX 的 CI 或 Linux 环境仍应运行完整 `pnpm test`。

文档变更至少执行：

```powershell
git diff --check
```

并检查 Markdown 相对链接是否有效。

## 7. 文档分工

- `README.md` 面向使用者和部署者，只保留项目用途、主要能力、安装、配置、Provider 边界、文档入口和来源许可。
- 测试命令、内部实现细节、协作规则、分支策略和提交规范统一写入 `AGENTS.md`，不要放回 README。
- `docs/` 只存放已落地、可交付的架构、流程、数据模型、集成和运维文档。
- 后续开发、实施、重构和迁移计划统一写入仓库根目录的 `plans/`。
- `plans/` 已被 `.gitignore` 排除，计划文档不得提交、推送或复制到 `docs/`。
- SETUP 是面向执行初始化的操作指南，不是开发计划或临时笔记。

## 8. Git 与提交规范

### 工作方式

- 修改前先检查 `git status`，不得覆盖与当前任务无关的用户改动。
- 默认在当前工作分支完成修改；未经用户明确要求，不创建 PR、不自行合并 PR。
- 用户要求提交时，直接提交并推送到 `main`。
- 不强制推送已共享的 `main`；不得用 `git commit --amend` 修改已推送提交。
- 不使用 `--no-verify` 绕过校验。
- 一个提交只包含一个可解释的主题，不混入无关格式化或生成物。

### Commit message

整个提交信息必须只有一行，不换行，不写标题正文分隔：

```text
<type>: <中文主题>，<具体变更1>，<具体变更2>
```

允许的 `type`：

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修复缺陷、小改动、补漏、配置或样式调整 |
| `refactor` | 涉及 5 个及以上文件且改变整体架构或设计模式的大规模重构 |
| `style` | 不改变逻辑的样式或格式调整 |
| `i18n` | 国际化和本地化 |
| `chore` | 依赖、构建、工具和维护工作 |
| `docs` | 仅文档变更 |
| `test` | 仅测试变更 |

硬性要求：

- 类型后使用半角冒号和空格：`fix: `。
- subject 使用中文，具体描述影响模块和实际变更。
- 不写句号，不使用序号列表，不重复主题。
- 不满足 `refactor` 全部条件时，一律使用 `fix`。
- 禁止 `WIP`、`update`、`changes`、`fix bug` 等空泛描述。
- 不提交 `.env`、Token、真实姓名、邮箱、SQLite 数据、`.run/`、`lib/` 或凭据。

## 9. 审查重点

涉及以下区域时，必须额外审查：

- 审批：Grant 哈希、排期、过期、一次性消费、撤回和改期。
- 插件：HMAC、timestamp、nonce、idempotency、重试和 outbox。
- Source：多实例隔离、游标恢复、线程键、健康状态和路由确定性。
- 工作区：配置版本、绑定哈希、跨仓库隔离和人工改派。
- 执行：用户输入到 Shell 的边界、worktree、分支、PR 和失败回执。
- 数据：迁移兼容、事务边界、append-only 审计和测试数据清理。
- 客户端：中文提示、错误态、窄屏、权限隐藏与服务端校验一致性。

## 10. 禁止事项

- 禁止让人工批准前的请求产生 Ticket、worktree、命令执行或 Git 副作用。
- 禁止执行侧自行生成 canonical Grant ID。
- 禁止把未实现的 Provider 或事件轮询能力描述为已支持。
- 禁止提交真实密钥、Cookie、Token、个人数据、生产数据库或 DSH profile。
- 禁止把开发计划提交到 README、`docs/` 或 Git。
- 禁止为了让测试通过而删除测试、放宽断言、吞掉异常或引入未记录的安全绕过。
- 禁止擅自重置、清理或覆盖真实 DSH 状态、数据库和用户配置。
- 禁止将本项目描述为 DeepSeek 官方仓库或官方产品。