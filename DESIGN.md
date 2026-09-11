# rethink-managed-agent：薄 Harness + 可插拔 Sandbox 设计

## 0. 一句话

**Harness 只做一件事：跑 agent loop 并把一切写进 append-only 事件日志。**
Sandbox 是可插拔的"计算租约"，不是 session 的一部分；session 只持有"工作区引用"，需要执行时才去租一个 sandbox。

## 1. 现有产品为什么"重"

以 Claude Managed Agent / Qoder Cloud Agent 这类产品为参照，重的根源不在功能多，而在几个耦合：

| 耦合 | 后果 |
|---|---|
| session ≡ 容器生命周期 | session 挂起就得快照/冻结整个容器；恢复要等容器起来；一个 session 只能在一个容器里跑 |
| 工具栈内置在平台 | 加一个工具要改平台；用户无法用自己的 shell/自己的 MCP |
| 状态散落在平台 DB + 容器磁盘 | "恢复"要同时恢复两处，语义模糊；无法把 session 搬到别的 sandbox |
| 控制面承担 orchestration | 计划模式、子 agent、审批流全在平台层，每加一个能力平台就厚一层 |

pi（Mario Zechner 的 pi coding agent）的反面做法：loop 极小、工具是普通函数、session 是可重放的 JSONL 树、所有"高级能力"都是 extension 而不是 core。本设计把这套思想搬到"托管/云端"形态，并补上它没有的一层：sandbox 的解耦。

## 2. 设计原则

1. **Harness 极薄**：core 只有 loop、事件日志、工具分发、provider 抽象。目标 < 1500 行。
2. **一切皆事件**：session 状态 = 事件日志的折叠结果。没有第二份真相。
3. **Sandbox 是租约（lease），不是所有物**：session 不拥有 sandbox，只在需要时 acquire，用完 release。
4. **工作区（workspace）才是持久的**：文件状态用 git commit + diff 或 volume snapshot 表达，sandbox 只是加载它的临时算力。
5. **工具对 provider 无感**：工具只拿到 `ctx.sandbox` 这个接口，不知道背后是本机、docker 还是 firecracker。
6. **扩展即模块**：工具、系统提示片段、事件 hook、sandbox provider 全是可以 import 的普通模块，没有插件注册中心。

## 3. 三层结构

```
┌──────────────────────────────────────────────────────────┐
│ Control Plane（可选，很薄）                                │
│ HTTP/WS: createSession / send / stream / list             │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│ Harness Core                                              │
│  AgentLoop  ─ Model provider ─ ToolRegistry ─ EventLog     │
│      │                                                    │
│      │ ctx.sandbox (接口)                                  │
└──────┼───────────────────────────────────────────────────┘
       │ SandboxLease (acquire / release)
┌──────▼───────────────────────────────────────────────────┐
│ Sandbox Layer（可插拔）                                    │
│  Provider: local | docker | firecracker | e2b | k8s | ssh  │
│  WorkspaceMaterializer: git | volume-snapshot | rsync      │
└──────────────────────────────────────────────────────────┘
```

三个独立生命周期：

| 对象 | 生命周期 | 持久化 |
|---|---|---|
| Session | 用户对话的生命周期，可挂起数天 | 事件日志（JSONL） |
| Workspace | 代码/文件状态，可跨 session 共享 | git ref + diff，或 snapshot id |
| Sandbox | 分钟级到小时级，随时可销毁 | 无（可丢） |

## 4. 核心接口

### 4.1 Sandbox（provider 必须实现的最小面）

```ts
interface Sandbox {
  id: string;
  exec(cmd: string, opts?: { cwd?: string; env?: Record<string,string>; timeoutMs?: number; signal?: AbortSignal })
    : AsyncIterable<ExecChunk>;              // 流式 stdout/stderr + exit
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  // 可选能力，用 capability 声明，工具按需降级
  capabilities: { ports?: boolean; snapshot?: boolean; gpu?: boolean };
  exposePort?(port: number): Promise<URL>;
  snapshot?(): Promise<SnapshotRef>;
}

interface SandboxProvider {
  name: string;
  acquire(req: SandboxRequest): Promise<SandboxLease>;
}

interface SandboxRequest {
  workspace: WorkspaceRef;      // 要在里面加载什么
  image?: string;
  resources?: { cpu?: number; memMb?: number };
  secrets?: Record<string,string>;   // 租约时注入，不落日志
  affinity?: string;            // 提示 provider 复用某个已有 sandbox（同 workspace 的多个 session）
}

interface SandboxLease {
  sandbox: Sandbox;
  release(): Promise<void>;     // 归还；provider 决定销毁还是回池
  ttlMs: number;                // 空闲多久自动回收
}
```

`exec/readFile/writeFile` 三个方法就够跑 90% 的工具。别的都放 capabilities。

### 4.2 Workspace（持久层，session 与 sandbox 之间的桥）

```ts
type WorkspaceRef =
  | { kind: "git"; remote: string; base: string; patch?: BlobRef }   // commit + 未提交 diff
  | { kind: "snapshot"; provider: string; id: string }               // volume / overlay 快照
  | { kind: "local"; path: string };                                 // 本机开发

interface WorkspaceMaterializer {
  materialize(ref: WorkspaceRef, sb: Sandbox): Promise<void>;  // 把 workspace 放进 sandbox
  capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef>; // 从 sandbox 提取新状态
}
```

session 挂起时：`capture` → 新 `WorkspaceRef` 写进事件日志 → `lease.release()`。
恢复时：读日志得到最新 `WorkspaceRef` → `acquire` → `materialize`。整个 sandbox 可以是全新的，甚至换 provider。

### 4.3 Session 与事件日志

```ts
type Event =
  | { t: "user"; text: string }
  | { t: "assistant"; content: ContentBlock[] }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; output: unknown; truncated?: boolean }
  | { t: "workspace"; ref: WorkspaceRef }          // 工作区状态变更点
  | { t: "sandbox"; action: "acquired" | "released"; provider: string; sandboxId: string }
  | { t: "meta"; ... };                             // 模型切换、system prompt 片段等

interface Session {
  id: string;
  log: EventLog;                    // append(ev) / replay() / fork(atEventId)
  workspace(): WorkspaceRef;        // 折叠日志得到最新 ref
}
```

关键：**session 里没有 sandbox 字段**。sandbox 只作为事件出现，用来审计和调试。
和 pi 一样，日志是树：`fork(atEventId)` 得到分支 session，共享前缀。两个分支可以各租各的 sandbox，也可以用 `affinity` 共享同一个。

### 4.4 Agent loop（整个 harness 的核心，示意）

```ts
async function run(session: Session, model: Model, tools: ToolRegistry, provider: SandboxProvider) {
  let lease: SandboxLease | null = null;
  const sandbox = async () => (lease ??= await acquireAndLog(session, provider)).sandbox;

  while (true) {
    const msgs = session.log.replay();                 // 折叠成模型上下文
    const resp = await model.stream(msgs, tools.schemas());
    session.log.append({ t: "assistant", content: resp.content });
    const calls = resp.toolCalls();
    if (calls.length === 0) break;

    for (const c of calls) {
      session.log.append({ t: "tool_call", ...c });
      const out = await tools.get(c.name).run(c.input, { sandbox, session, signal });
      session.log.append({ t: "tool_result", id: c.id, output: out });
    }
  }
  if (lease) { await captureAndLog(session, lease.sandbox); await lease.release(); }
}
```

注意 `sandbox` 是懒获取的：纯对话的 turn 根本不租 sandbox。

### 4.5 Tool

```ts
interface Tool<I> {
  name: string;
  schema: JSONSchema;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}
interface ToolContext {
  sandbox(): Promise<Sandbox>;   // 懒
  session: Session;
  signal: AbortSignal;
}
```

内置工具只有 `bash`、`read`、`write`、`edit` 四个，全部通过 `ctx.sandbox()` 干活。
"子 agent""计划模式""审批"都不进 core：子 agent = 一个工具，内部 `fork` session 再调 `run`。

## 5. Sandbox 与 Session 的多对多

| 场景 | 做法 |
|---|---|
| 一个 session 跨多个 sandbox | 挂起/恢复自然发生；也可显式 `release` 再用不同 image/provider `acquire` |
| 多个 session 共用一个 sandbox | 同 workspace 的 review-session 与 fix-session 用相同 `affinity`；provider 返回同一实例，各 session 用自己的 cwd 或 git worktree 隔离 |
| 热池 | provider 维护预热实例，`acquire` 只做 `materialize`，冷启动从分钟级降到秒级 |
| 换 provider | 事件日志不变，只换 `provider` 参数；本机调试用 `local`，上云用 `firecracker` |
| 无 sandbox | 纯问答 / 只读 workspace（通过 git remote 直接读）都不租 |

并发写同一 sandbox 的保护不放在 core：由 materializer 用 worktree 隔离，或 provider 拒绝重复 `affinity`。

## 6. Control plane 保持薄

```
POST /sessions                { workspace, model }         → { id }
POST /sessions/:id/messages   { text }                     → 202
GET  /sessions/:id/events     (SSE / WS, 支持 since=)
POST /sessions/:id/fork       { atEventId }
POST /sessions/:id/suspend    → capture + release
```

没有 sandbox 相关 API。想看 sandbox 就看事件流里的 `sandbox` 事件。
控制面本身无状态，session 日志放对象存储或 SQLite，多实例横向扩就是复制 loop 进程。

## 7. 扩展点（全是普通模块）

```ts
export default {
  tools: [myTool],
  systemPrompt: (ctx) => "...",           // 片段拼接，不替换
  onEvent: (ev, session) => {},           // 审计 / 遥测 / 审批拦截
  providers: { myCloud: myProvider },
  materializers: { git: gitMaterializer },
} satisfies Extension;
```

审批流的实现方式：`onEvent` 在 `tool_call` 时抛 `NeedsApproval`，loop 把事件写成 `pending` 并挂起 session；用户批准后 append `approved` 事件再继续。core 只需要知道"挂起/继续"，不知道什么是审批。

## 8. 与厚 harness 的对比

| | Managed Agent 式 | 本设计 |
|---|---|---|
| session 恢复 | 恢复容器 | 重放日志 + 重新 materialize |
| 换运行环境 | 不可 | 换 provider 参数 |
| 增加工具 | 改平台 | 写一个函数 |
| 挂起成本 | 容器占资源或快照 | 一个 git diff |
| 多 session 同工作区 | 通常不支持 | affinity + worktree |
| core 规模 | 平台级 | ~1500 行 |

## 9. 取舍与已知代价

- **冷启动**：不绑定容器意味着每次恢复要 materialize。用热池和 snapshot provider 缓解，但比"容器一直活着"慢。
- **非 git 状态**：安装的依赖、跑着的服务、数据库不在 git 里。靠 `snapshot` capability 或在 materializer 里跑 `setup` 脚本（写在 workspace 的配置文件里，例如 `.agent/setup.sh`）。
- **secrets**：只在 `acquire` 时注入，绝不进事件日志；日志要脱敏 tool_result。
- **共享 sandbox 的并发**：core 不做锁，交给 provider/materializer，需要明确文档化。
- **大输出**：tool_result 需要截断并把全文存 blob，日志只留引用，否则重放成本失控。

## 10. MVP 路线

1. `core/`：EventLog(JSONL)、AgentLoop、ToolRegistry、4 个内置工具。
2. `sandbox/local`：直接跑子进程；`materializer/git`。
3. CLI：本机跑通，session 可挂起、fork、恢复。
4. `sandbox/docker`：验证"同一日志换 provider"。
5. 薄 control plane（HTTP + SSE）。
6. 热池 + `sandbox/firecracker` 或 e2b provider。
7. 扩展：子 agent 工具、审批 hook。

每一步都应保持 core 不长。如果某个功能让 core 变厚，先问它能不能是 extension。

## 11. 会话与沙箱 N:N（定稿）

早期实现里 session 对 workspace 一对一，sandbox 由 workspace 的 affinity 决定，一个会话同一时刻只有一个沙箱。这一节把关系定为 N:N，并且仍然守住两条原则：events 是唯一真相；sandbox 只是租约。

### 11.1 模型

```
session ──1:N── session_environments(key, environment, workspace)
                       │  key = "main" 是主环境（工具默认目标，capture 的主体）
                       │  其余 key 是附加环境，如 "browser"、"gpu"
                       ▼
workspace ──N:1 sandbox lease（affinity = workspace.id，同一时刻至多一个活跃租约）
```

- **一个会话多个沙箱**：会话挂多个环境，每个环境各自租沙箱。内置工具增加可选参数 `env`，默认 `main`。事件 `sandbox.acquired` 带 `env`，`workspace.captured` 带 `workspace_id` 和 `env`，多个并存不需要新的事件模型。
- **多个会话一个沙箱**：不变，同一 workspace 的会话靠 affinity 复用，活跃租约互斥。
- **子会话**：`sessions.parent_id`。子会话拥有从父会话 fork 出来的 workspace（git 类型复制 base 加 patch，dir 类型复制目录），因此有自己的沙箱，和父会话并行互不踩文件。子会话结束时父会话收到 `agent.thread_message_received`，内容是报告加 patch；父会话决定是否 apply。事件名对齐 Managed Agents 的 multiagent。

### 11.2 运行时

- run-turn 持有 `Map<envKey, lease>`，懒租；结束时逐个 capture 和 release。
- 插件的 `ctx.sandbox` 也接受 `env`；`ctx.agent.run(task, { isolated: true })` 创建子会话并等待其结束，而不是在同一沙箱里跑嵌套 loop。
- runner 有并发度（`RUNNER_CONCURRENCY`），否则父会话等待子会话会死锁在单消费者上。

### 11.3 明确不做的

- 不在一个沙箱里跑多个会话的并发写：仍由 affinity 互斥保证。
- 不做跨会话共享租约的"沙箱池"语义：沙箱复用只发生在同一 workspace 内。
- 不支持一个 workspace 同时挂到两个环境，附加环境要么自带 workspace，要么 fork 主 workspace。

## 12. 沙箱 idle / pause / resume

租约释放后沙箱不立即销毁，而是分两级退役，两个阈值都可配：

```
busy ──release──► ready ──idle > SANDBOX_IDLE_TTL_MS──► paused ──idle > SANDBOX_PAUSED_TTL_MS──► destroyed
                    ▲                                     │
                    └──────────── 下次 acquire 自动 resume ─┘
```

- **ready**：容器还在跑，命中同一 workspace 的会话秒级接上（`origin: reused`）。
- **paused**：docker 用 `pause`(freezer cgroup 冻结进程,内存态保留、CPU 释放),下次 `unpause` 原地恢复,连后台进程都还活着;e2b 用 SDK 的 `pause` 快照,同样保留内存态。语义统一:pause 这一层保状态(文件+进程),destroy 才真正回收。下次 acquire 时 manager 先 `resume` 再 `connect`(`origin: resumed`)。没有 pause 能力的 provider(local)直接销毁。
- **destroyed**：之后再来就是从 workspace ref 重建（`origin: created`）。

运维入口：`POST /v1/sandboxes/:id/pause` 和 `DELETE`，都由 runner 的 reaper 在下一轮执行，API 进程不直接碰容器。`sandbox.acquired` 事件带 `origin` 字段，能看出每次是新建、复用还是恢复。

## 13. BYOC 与 BYOK

- **BYOC**：`byoc` provider 的沙箱在用户自己跑的 `pma worker` 上。worker 只发起出站长轮询，runner 的 exec / read / write / capture 经 Redis 列表和 API 中转到 worker，结果原路返回。每个环境一把 worker key，创建时返回一次。同一 workspace 的沙箱靠 worker 心跳判断是否还在，非 git 工作区以 `{kind:"byoc", worker, path}` 留在 worker 磁盘上。这是 Managed Agents 的 self-hosted 形态在本设计里的对应物，harness 和事件模型完全不变。
- **BYOK**：provider 的凭证多一种 `{type:"key"}` 输入，API 用 `PMA_SECRET_KEY` 做 AES-256-GCM 封存后落库，读取永不返回密文，runner 解封后注册 provider。运营方的 key 仍用 `{type:"env"}` 引用。

## 14. 多 Agent

参考 pi 生态（tintinweb/pi-subagents、nicobailon/pi-subagents、pi-dynamic-workflows）：它们都是"多实例"，子 agent 是独立会话，隔离靠 git worktree，编排是一段确定性 JS 脚本，子对父通过 intercom 通信。本设计里对应物已经存在，只是换了名字：

| pi 生态 | 本设计 |
|---|---|
| 子 agent 独立会话 | 子 session（`parent_id`），任意 runner 并发执行 |
| git worktree 隔离 | workspace fork，各自沙箱 |
| `agent()` / `parallel()` / `pipeline()` 脚本 | `plugins/workflow` 的 `run_workflow`，脚本形状相同 |
| intercom `contact_supervisor` | 内置 `report_to_parent`，问题会结束子会话的 turn，父的 reply 作为子的下一条用户消息 |
| agent types / frontmatter | `plugins/team` 的角色（store 里可改） |

核心只加了 `ctx.agents.*` 六个能力和一个内置工具，事件对齐 Managed Agents 的 `session.thread_created`、`agent.thread_message_sent/received`。团队与工作流本身全是插件。

## 15. Principal 与归属（多租户 phase 1）

不引入 `user_id`，而是一个多态主体 `principals(id, kind, ...)`：用户、组织、服务账号都是它的一种 `kind`。每个顶层资源（agents / environments / workspaces / providers / files / skills / memory_stores / sessions）加一列 `owner_id → principals(id)`。今天 `owner_id` 一律指向 `kind='user'` 的主体;将来指向 `kind='org'` 即可，资源表一列都不用改——扩展到组织是加行加表，不是全表迁移。

- **actor 与 owner 分离**：actor 是认证后的调用方(一个 principal);owner scope 是资源归属的边界。phase 1 里 owner == actor;有组织后由 `X-Org` 头选定、经 membership 校验后换成 org 主体。
- **认证**：`api_keys(token_sha256 → principal)`,`Authorization: Bearer <token>`。`AUTH_REQUIRED=false`(默认)时无 token 回落到 `PMA_DEFAULT_PRINCIPAL`(即 schema 里种子的 `prc_local`),单机流程零改动;`=true` 时强制校验。BYOC worker 走 `x-worker-key`,不经主体认证。
- **归属贯穿**：API 中间件把 `{actor, owner}` 放进 context;create 路由 stamp `owner_id`,list/get/update/delete 传入 owner scope 后加 `WHERE owner_id=$n`,集中在 `src/infra/db.ts` 的 repo 里。runner / harness 以系统身份读(不带 scope),因为它要处理任意 owner 的会话;子 session 和 fork 的 workspace 继承父的 `owner_id`。
- **授权 seam**：留一个函数式判断点,phase 1 就是 `resource.owner_id === actor.id`;有组织后换成"actor 是该 org 成员且角色允许",调用点不变。

**扩展到组织(增量)**:加 `principals` 里 `kind='org'` 的行 + `memberships(member_id, org_id, role)` + `X-Org` 解析,资源表和 repo 逻辑不动。

**phase 2(已完成):按 owner 收口隔离**
- **容器不跨主体**:`container_key` 前缀加 `owner_id`(`${owner}/${container_group}/${env}`),所以 manager 找同 key 复用容器时永远不会把两个主体的 mount 并进同一个容器;共享容器只在同一 owner 内成立。
- **sandbox 归属**:`sandboxes.owner_id`(临时行,可空、无 FK),acquire 时写入;`/v1/sandboxes` 运维视图(list/get/delete/pause)按调用方 owner 过滤,跨主体查不到。reaper 仍以系统身份按 provider 扫描。
- **plugin_store 主体隔离已天然成立**:`owner`(agent_id / workspace_id)由服务端按会话上下文绑定,插件只能传 `key`+`scope`,而 agent/workspace 各属唯一主体,所以插件访问不到别的主体的数据。phase 2 额外加了 `scope="principal"`(owner = `session.owner_id`),给插件一份租户级存储。
- **fetch 白名单按主体**:`principals.fetch_allow`(逗号列表或 `*`),每次运行取该主体策略,缺省回落到部署级 `PLUGIN_FETCH_ALLOW`。

**身份是可插拔的接缝(隔离留在平台,身份交给业务侧)**。rethink 只拥有*隔离*边界(每个资源带 `owner_id`,仓储层强制),不规定"用户/组织"是什么。一个凭证如何变成 principal 由 `PrincipalResolver`(`src/api/principal-resolver.ts`)决定:部署方用 `PRINCIPAL_RESOLVER` 指向一个默认导出该 resolver 的模块,业务侧把自己的身份接进来(校验过的 JWT/OIDC、可信网关头、mTLS、每租户 key)。resolver 返回 `{actor, owner?}`,系统其余部分只看 `owner`;当 resolver 返回的 `owner` 不等于 `actor` 时,就是组织 scope 的接入点。内置默认是 Bearer→`api_keys`;`src/api/resolvers/trusted-header.ts` 是现成示例(信任上游网关的 `x-principal-id`,`x-org-id` 选 owner)。据此对外可讲两档:一套部署内 principals 做**软隔离**服务大量租户;要**硬隔离**的单独起一套栈。

**仍留给后续**:
- provider id 是全局主键,跨 owner 同名会 409(providers 偏基础设施,BYOK 密钥按行封存)。
- `AUTH_REQUIRED=true` 下的 API key 铸造仍对已认证 actor 开放,真实部署应再加 admin 门槛。
- 组织(`kind='org'` + `memberships` + 角色判断)是 phase 3,且应尽量薄、藏在 resolver 后面。

## 16. OpenAI Agents API 兼容层

一个薄适配器让 rethink 讲 OpenAI Agents API 的 session 方言,使 showcase 级代码(如 SRE "sev-bot")指到 rethink 的 base URL 就能跑,且**不绑任何云厂商**:模型解析到 rethink 的 provider 行(BYOK),环境解析到可插拔沙箱 provider(local/docker/e2b/byoc)。适配器挂在 `/agents-api/v1`,是对原生引擎的纯翻译;引擎唯一新增的是**客户端/函数工具**。

- **端点**:`POST /sessions`(create,`{agent, environment, input?, stream?}`)、`GET /sessions/:id`(retrieve,含 `info.required_actions`)、`POST /sessions/:id`(continue)、`POST /sessions/:id/tool_result`、`DELETE`、`GET /sessions/:id/events/stream`。挂在与原生 `/v1` 并列的独立前缀下,各自 `auth()`。
- **客户端/函数工具(核心机制)**:`{type:'function',name,parameters}` 由**调用方**执行,不进沙箱。agent 调用它时,这一轮保持存活,execute 在一个**按 call_id 的持久结果通道**(Redis 列表,非有损 pub/sub)上阻塞;调用方 POST `tool_result`(或人审批)后同轮恢复。未答的调用在 `CLIENT_TOOL_WAIT_MS`(默认 5 分钟,< `RUN_TIMEOUT_MS`)内表现为 `required_action`(retrieve + `agent.session.action_required` 流事件),超时则以一条超时错误结果结束该调用。
  - **为什么不是"永不 settle 的 promise + abort"**:pi 的循环对 `tool.execute` 是裸 `await`、不对 signal 做 race,那样会**死锁**且沙箱租约永不释放(对抗校验发现的关键坑)。所以照搬仓库里已验证的 `report_to_parent` 模式:execute 总是返回一个真实结果,循环正常展开,历史对 LLM 合法。
- **工具类型**:内置名(`bash/read/write/edit`)透传进沙箱;`mcp`/`web_search`/`programmatic_tool_calling` 接受并记为 ignored,除非注册了对应插件(留接口)。`multi_agent` 映射到团队插件包(`COMPAT_TEAM_PACKAGE`),`max_concurrent_subagents` 目前为 advisory。
- **流事件**:原生 delta/event 重编码成 OpenAI 名字(`response.output_text.delta`、`session.turn.item.added` 带 `function_call`、`agent.session.action_required`、`agent.session.turn.completed`、`turn.failed/cancelled`)。
- **SDK**:`src/api/routes/compat/sdk/` 提供零依赖的 `client.beta.agents.sessions.*` 客户端,自动跑有 handler 的函数工具并回传结果;没 handler 的调用作为 `required_action` 交回调用方(sev-bot 的审批门)。
- **MVP 边界**:webhook 投递 `action_required` 未做(SSE + retrieve 覆盖);真正的 MCP client、programmatic tool calling 未做(接受并映射/留接口);`input` 仅字符串;跨 idle 的冷恢复靠 keep-alive 长轮询覆盖(审批在窗口内完成)。
