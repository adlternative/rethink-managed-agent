# rethink-managed-agent(中文)

> English: [README.md](README.md)。设计细节见 [DESIGN.md](DESIGN.md),定位见 [docs/POSITIONING.md](docs/POSITIONING.md)。
> 代码与其余文档均为英文;本文件是 README 的中文版。

一个小巧、可自托管的编码 agent 服务,精神上对标 Claude Managed Agents,建立在三个想法上:

- **薄 harness。** agent 循环用 [pi](https://github.com/badlogic/pi-mono) 的 `runAgentLoop`(`@earendil-works/pi-agent-core`);我们只加四个工具(`bash`、`read`、`write`、`edit`)和一份 append-only 事件日志。**会话状态就是该日志的折叠结果——没有 messages 表。**
- **可插拔沙箱。** 计算是一次短生命周期的**租约**,永远不属于会话。会话只持有一个 workspace 引用(git base+diff、目录、或空);首次工具调用时才懒获取沙箱,turn 结束即释放。现有 provider:`local`、`docker`、`e2b`、`byoc`。
- **Managed-Agent 式 API。** agent/environment/session/events 都是 REST 资源;实时输出走 SSE;turn 进行中发来的用户消息会被 steer 进正在跑的循环。

## 先行者,以及我们的不同

我们真心欣赏 OpenAI Agents API 和 Anthropic Managed Agents 的架构。它们把分解做对了:**"大脑—手"分离**——模型负责思考,受管沙箱负责执行,上面盖一层持久会话。我们独立设计后落到了几乎一样的对象模型(agent / session / environment / events),这本身就是"这种分离是对的"的最强证据。想要**零运维、最快跑起来**的托管 agent,就用它们,它们很出色。

但那些设计里有两点我们认为**不够好**,并且要修:

- **它们把你绑死在一家云厂商。** 模型是厂商的,沙箱跑在厂商的基础设施上,事件日志也在那儿。你没法换自己的模型、跑在自己的 VPC、或做成气隙。rethink 把模型做成 provider 行(BYOK,任意 OpenAI/Anthropic 兼容端点),沙箱做成可插拔 provider(local/docker/e2b/BYOC),整条栈可自托管。
- **架构不够优雅。** 沙箱与会话 1:1 焊死,状态被劈成"不透明的平台存储"和"活着的容器"两半:挂起/恢复要冻结一个盒子,一个会话不能跨沙箱、也不能换沙箱,循环的真相藏在厂商内部。rethink 保留同样的"大脑—手"分离,但让**事件日志成为唯一真相**、**沙箱成为可弃的租约**——会话、workspace、沙箱变成三条独立生命周期,可自由组合(N:N、可重建、可共享)。core 之上的一切(子 agent、审批、计划模式)都是插件,而非平台。

同一个好想法,解耦并可移植。

## 快速开始(docker compose)

1. 在宿主机起模型代理(默认是 Qoder 的 OpenAI 兼容代理,监听 4141):
   ```sh
   cd ~/qoder-openai-provider && npm start   # http://127.0.0.1:4141/v1
   ```
2. 起整栈(postgres/redis/api/runner):
   ```sh
   cp .env.example .env
   docker compose up --build
   ```
3. 浏览器打开 **http://localhost:8080/** 看只读看板:会话列表、每个会话的事件时间线(消息、工具调用与结果、状态)、以及 SSE 实时 tail。

用自带 CLI 手动操作(`npm run cli -- <命令>`;`PMA_API` 默认 `http://localhost:8080`,旧的 `PI_API` 仍可用;开启 `AUTH_REQUIRED=true` 时用 `PMA_API_KEY` 传 Bearer key):
```sh
npm run cli -- agents create dev qoder/ultimate          # 旧写法 agent create --name dev --provider qoder --model ultimate 仍可用
npm run cli -- envs create local --provider local
npm run cli -- sessions create --agent agent_xxx --env env_xxx
npm run cli -- send sess_xxx "列出当前文件并加个 README" --wait
npm run cli -- events sess_xxx
npm run cli -- vaults create ci && npm run cli -- vaults credentials put vlt_xxx GITHUB_TOKEN --value-env GITHUB_TOKEN
npm run cli -- --help                                    # 全部命令;<命令> --help 看单个命令的参数
```
资源命令(agents/envs/sessions/vaults/memory-stores/files/skills/providers/sandboxes/models)与 `pma` 客户端一致,另有 `send`/`stream`/`events`/`interrupt` 和 BYOC 的 `worker --env <id> --key <worker_key>`。列表默认打表格,`--json` 输出原始 JSON;退出码 0 成功、1 API/网络/运行失败或超时、2 用法错误。

## 身份与归属(多租户)

每个顶层资源都归属一个 **principal**(多态主体:用户/组织/服务账号)。请求的主体从 `Authorization: Bearer <token>` 经 `api_keys` 解析,读写都按它 scope,一个主体看不到也改不了另一个主体的资源。`AUTH_REQUIRED=false`(默认)时无 token 回落到 `prc_local`,单机零改动。**身份来源是可插拔的**:把 `PRINCIPAL_RESOLVER` 指向一个模块即可接入自己的 JWT/OIDC、可信网关头、mTLS、每租户 key——平台只守隔离边界,"用户/组织"的语义交给业务侧。详见 DESIGN 第 15 节。

## 厂商 API 兼容层

rethink 在同一个引擎上讲三种方言:自己的原生 API,加上两家厂商的。服务端不引入任何厂商 SDK,请求也不会离开你的部署——每一层都只是边缘上的翻译。完整对照表,以及哪些地方**刻意做不到兼容**,见 [DESIGN 第 21 节](DESIGN.md)。

| 接口 | SDK 指向 | 覆盖 |
|---|---|---|
| **OpenAI Agents API** | `new OpenAI({ baseURL: "<host>/openai/v1" })` | `client.beta.agents.*`:agent、session(含流式)、事件、items、turns、子 agent、artifacts、vault 及凭据 |
| **Claude Managed Agents** | `new Anthropic({ baseURL: "<host>/anthropic" })` | `client.beta.{agents,sessions,vaults}.*`:agent(工具集、MCP server)、session(含 SSE)、thread、vault 及凭据、environment、memory store |
| **原生** | `pma` CLI 或你自己的代码,`/v1` | 全部能力,包括两种方言里没有对应说法的那些 |
| 旧的 showcase 适配器 | `/agents-api/v1` | 为已有调用方保留,不再演进 |

两个厂商接口都用厂商自己的 SDK(`openai@7.15.0`、`@anthropic-ai/sdk@0.123.0`)驱动路由跑过测试,也都在活栈上端到端验证过。

凡是本质上属于**agent loop 的行为**的厂商功能,这里都用插件实现而不是写进引擎:CMA 的 **outcome**(定义"做完"是什么、给这次 run 打分、不达标就打回重做)就是 `plugins/outcome`,只用普通钩子,方言层在上面接一层(`COMPAT_OUTCOME_PACKAGE`)。见 [DESIGN 第 21.3 节](DESIGN.md)。

模型走 rethink 的 provider 表解析,所以厂商的模型 id 需要有同名 provider 行,或者在 `COMPAT_MODEL_MAP` 里映射。MCP 凭据放在 vault 里,按 URL 匹配到声明的 server(也可以用 `credential_id` 指定),不会存在可复用的 agent 上。`permission_policy` 是 `always_ask` 的 MCP 工具会被挂起,等调用方确认后才执行。

### 旧的 showcase 适配器(`/agents-api/v1`)

一个薄适配器让 rethink 讲 OpenAI Agents API 的 session 方言,showcase 级代码指到本地 base URL 就能跑,且**不绑任何云厂商**(模型走 provider+BYOK,环境走可插拔沙箱)。核心新增是**客户端/函数工具**(结果由调用方提供);`{type:'mcp'}` 由 runner 端真实 MCP-over-HTTP 客户端连接;`web_search` 复用现成的 web-search 插件;`multi_agent` 映射到团队插件。零依赖 SDK 在 `src/api/routes/compat/sdk/`。详见 DESIGN 第 16 节。

`examples/` 下有对齐 OpenAI showcase 的无凭证例子:`sev-bot`(客户端工具+人审批)、`code-agent`(沙箱跑代码)、`doc-review`(多 agent)、`docs-qa`(真实 MCP)。`demos/`(`make demo`)则证明托管方结构上给不了的性质:N:N 沙箱、可弃可重建、共享容器、provider 切换、暂停恢复。

## 插件

插件是普通 npm/git/本地包,导出 `(p) => void`,在一个能力受限的独立 host 进程里加载(runner 模式用 Node `--permission` + 网络锁定;或 `plugin_host=sandbox` 让 host 跑进沙箱)。三个扩展点:`registerTool`、`registerCommand`、`on(hook)`。插件碰的一切都是中介能力 `ctx.*`(sandbox/store/model/agent/agents/fetch/session)。**审批/权限是 `tool_call` 钩子(pi 式),不进 core。** 详见 [docs/PLUGINS.md](docs/PLUGINS.md)。
