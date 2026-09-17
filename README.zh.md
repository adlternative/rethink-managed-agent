# rethink-managed-agent(中文)

> English: [README.md](README.md)。设计理由见 [DESIGN.md](DESIGN.md),定位见 [docs/POSITIONING.md](docs/POSITIONING.md),
> 运行细节见 [docs/GUIDE.md](docs/GUIDE.md)。代码与其余文档均为英文;本文件是 README 的中文版。

一个小巧、可自托管的编码 agent 服务,对标 Claude Managed Agents 和 OpenAI Agents API——同样的"大脑—手"
分离,但解耦到你可以自己跑:

- **事件日志是唯一真相。** 会话状态就是这份 append-only 日志的折叠结果。没有 messages 表,也没有藏在容器里的东西。
- **沙箱是租约。** 会话只持有 workspace 的**引用**(git base+diff、目录、或空);首次工具调用才获取计算资源,
  turn 结束即释放。会话、workspace、沙箱是三条独立生命周期,可自由组合(`local`、`docker`、`e2b`、或你自己跑的 worker)。
- **模型是一行数据。** 任何讲 `openai-completions`、`openai-responses`、`anthropic-messages` 的端点都能接——
  你的网关、你的 vLLM、你的 key。
- **循环之上的一切都是插件。** 子 agent、审批、outcome、校验、记忆:都是钩子和工具,不是平台。

循环本身是 [pi](https://github.com/badlogic/pi-mono) 的 `runAgentLoop`,加四个工具(`bash`、`read`、`write`、`edit`)。

## 对象模型

| | |
|---|---|
| **Agent** | 可复用的定义:模型、system prompt、工具、插件、MCP server |
| **Environment** | 计算发生的地方:沙箱 provider + 默认 workspace 规格 |
| **Session** | 一次对话。创建时快照 agent,所以改 agent 不会影响在跑的会话 |
| **Workspace** | 持久的文件状态,以引用形式存在(git base+diff、捕获的目录、blob) |
| **Sandbox** | 临时计算,按 turn 租用,可回收,会话从不引用它 |
| **Event** | 日志。其余一切都是它的投影 |

## 快速开始

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

## 模型来自 provider 行,跟本仓库无关

**provider** 就是一行数据:`{id, api, base_url, auth, models[]}`。`api` 是 pi-ai 认识的三种形状之一——
`openai-completions`、`openai-responses`、`anthropic-messages`——所以只要对方讲其中一种就能接:OpenAI、
Anthropic、自建的 vLLM / Ollama、公司网关、任何 OpenAI 兼容代理。agent 用 `{provider, id}` 指模型,
provider 行一变 runner 就重建模型注册表。

```bash
pma providers create my-vllm --api openai-completions --base-url http://gpu-box:8000/v1 --no-auth --models qwen3:128000
pma agents create coder my-vllm/qwen3
```

`.env.example` 里的 `QODER_*` 只是**本地开发的种子**:首次启动时如果 providers 表是空的,就插一行指向本地
的 OpenAI 兼容代理,好让刚 clone 的仓库不配任何 key 也能跑。`pma providers delete qoder` 删掉即可,引擎里
没有任何地方认这个 id。

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
