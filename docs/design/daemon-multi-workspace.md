# Daemon Multi-Workspace Support Design

日期：2026-07-06

## 背景

当前 daemon 的公开模型是 `1 daemon = 1 workspace x N sessions`。这不是单个文件里的限制，而是从启动参数、HTTP 路由、ACP bridge、SDK 到文档都贯穿一致：

- `packages/cli/src/serve/types.ts` 的 `ServeOptions.workspace` 注释明确说明单 daemon 绑定单 workspace，多 workspace 需要多个 daemon 进程。
- `packages/cli/src/serve/server.ts` 在应用启动时只 canonicalize 一个 `boundWorkspace`，并把同一个 `AcpSessionBridge`、`DaemonWorkspaceService` 和 primary-only REST filesystem factory 注入所有路由。
- `packages/acp-bridge/src/bridge.ts` 维护单个 `defaultEntry`、单个 `channelInfo`、单个 `boundWorkspace` 校验和单 child/channel 连接。
- `docs/users/qwen-serve.md`、`docs/developers/daemon/*`、`packages/sdk-typescript/src/daemon/types.ts` 都把 `workspaceCwd` 描述为单值。

同时，代码里已经有一些多 workspace 的局部基础：

- `packages/cli/src/serve/fs/workspace-file-system.ts` 已支持 `boundWorkspaces: string[]`，可以在多个 trusted root 内做绝对路径读写和 glob。
- `packages/cli/src/serve/run-qwen-serve.ts` 会从 IDE 环境解析多个 workspace root，并把 trusted secondary roots 传给 bridge filesystem boundary。
- `packages/cli/src/serve/server/session-list.ts` 和 `packages/sdk-typescript/src/daemon/DaemonClient.ts` 已经有按 workspace cwd 查询 sessions 的 API 形态。
- `packages/core/src/services/sessionService.ts` 的持久化模型按 `workspaceCwd` 分区，天然适合多 workspace。

关键结论：已有 multi-root filesystem boundary 不能直接等价为 multi-workspace daemon。前者只是一个 workspace runtime 里的文件边界；后者需要 session、ACP child、settings、MCP、permissions、memory、status、lifecycle 等 workspace-scoped 状态都能隔离和寻址。

## 目标

支持一个 daemon 进程同时服务多个 workspace，并保持旧客户端的单 workspace 行为不变。

具体目标：

1. 老客户端不传 workspace 时继续落到 primary workspace。
2. 新客户端可以在创建 session、列 session、文件操作、workspace 状态和 workspace scoped 操作时选择 workspace。
3. 不把不同 workspace 的 sessions、settings、runtime MCP、permissions、memory tasks、filesystem writes 混在一起。
4. 保持 ACP bridge 的现有单 workspace 语义，避免一次性重写核心会话桥。
5. 给服务端设置明确资源边界，避免一个进程因为多个 workspace 无限制扩张。

## 非目标

首版不做这些能力：

1. 动态任意路径注册 workspace。
2. 一个 ACP child 同时承载多个 workspace。
3. 多 workspace 之间共享 default session。
4. 把 IDE multi-folder filesystem roots 自动提升成完整 daemon workspace。
5. 给所有历史 URL 一次性做破坏性迁移。

这些可以作为后续扩展，但不进入首版设计。

## 术语

- Primary workspace：daemon 启动时的第一个 workspace。所有 legacy route 默认使用它。
- Workspace runtime：一个 workspace 对应的一组服务对象，包括 bridge、workspace service、filesystem factory、MCP sender registry、memory task lane、status provider 等。
- Workspace registry：daemon 进程内的 runtime 注册表，负责 workspace 解析、session 到 workspace 的索引、聚合关闭和聚合状态。
- Workspace key：canonicalized absolute cwd。首版直接作为内部 key；HTTP path 中继续使用 `encodeURIComponent(cwd)`。
- Workspace root：文件系统 root。一个 workspace runtime 可以包含多个 filesystem roots，但它们仍属于同一个 workspace runtime。

## 方案选项

### 选项 A：继续多 daemon，由外部 registry 编排

做法是保持现状，每个 workspace 启一个 daemon，在 SDK 或 IDE 层维护端口和 token registry。

优点：

- 最小改动。
- workspace 隔离最强。
- 不碰 ACP bridge、routes 和 workspace service 的内部结构。

缺点：

- 不能满足“一个 daemon 支持多个 workspace”的产品目标。
- Web Shell、SDK、IDE 插件需要同时管理多个端口和 auth token。
- 无法在一个 `/capabilities` 或 `/daemon/status` 里聚合状态。

结论：可以作为 fallback 或短期部署策略，但不是本设计推荐方案。

### 选项 B：一个 daemon 进程，多个独立 workspace runtime

做法是在同一个 Express app 内引入 `WorkspaceRegistry`。每个 workspace runtime 继续拥有自己的单 workspace `AcpSessionBridge` 和 `DaemonWorkspaceService`。HTTP route 先解析 workspace，再把请求分发给对应 runtime。

优点：

- 复用现有单 workspace bridge，不把最复杂的 ACP 会话状态改成多维 map。
- settings、MCP、permissions、memory、status、filesystem trust 可以按 workspace 隔离。
- 旧 route 保持 primary 默认，兼容性好。
- 可以分阶段落地：先单 runtime registry 无行为变化，再启用多 workspace。

缺点：

- 每个 active workspace 可能有自己的 ACP child，资源占用比单 child 高。
- route 层需要逐步从 `app.locals.boundWorkspace` 迁移到 workspace resolver。
- session-scoped route 需要维护 `sessionId -> workspaceKey` 的索引或 fallback 查找。

结论：推荐方案。它以最小核心改动换取清晰隔离。

### 选项 C：一个 bridge 内部支持多个 workspace，每个 workspace 一个 child/channel

做法是把 `AcpSessionBridge` 改成 `Map<workspaceKey, WorkspaceBridgeState>`，每个 state 有自己的 default session、channel、in-flight spawn、alive channels。

优点：

- route 层可以继续只持有一个 bridge。
- session 相关接口天然可在 bridge 内部路由。

缺点：

- 需要重写 bridge 核心状态模型，改动集中在会话生命周期和并发控制上。
- bridge 会同时承担 HTTP workspace registry 和 ACP session bridge 两种职责。
- 更容易超过 core 基础设施的低风险改动边界。

结论：不建议作为首版。只有在选项 B 证明 route registry 过于复杂时再考虑。

### 选项 D：一个 ACP child 同时支持多个 workspace

做法是所有 workspace 共用一个 ACP child，只在 `newSession({ cwd })` 上传不同 cwd。

优点：

- 资源占用最低。
- 单 child 里已有部分 concurrent `newSession` 不同 cwd 的测试基础。

缺点：

- workspace-level ext methods、runtime MCP、memory、status、permissions、settings、LSP 状态可能混用。
- ACP 协议里的 sessionless 请求需要额外 workspace 维度，否则无法判断请求属于哪个 workspace。
- 任何 child 内部全局缓存都会成为跨 workspace 泄漏风险。

结论：不建议。除非先把 ACP child 的 workspace-scoped 能力协议化并验证全链路隔离。

## 推荐架构

采用选项 B：一个 daemon 进程托管多个独立 workspace runtime。

高层结构：

```text
Express app
  |
  +-- global auth / cors / rate limit / access log
  |
  +-- WorkspaceRegistry
        |
        +-- primary runtime
        |     +-- AcpSessionBridge(boundWorkspace=A)
        |     +-- DaemonWorkspaceService(boundWorkspace=A)
        |     +-- WorkspaceFileSystemFactory(boundWorkspaces=[A, ...A roots])
        |     +-- ClientMcpSenderRegistry(A)
        |
        +-- runtime B
        |     +-- AcpSessionBridge(boundWorkspace=B)
        |     +-- DaemonWorkspaceService(boundWorkspace=B)
        |     +-- WorkspaceFileSystemFactory(boundWorkspaces=[B, ...B roots])
        |     +-- ClientMcpSenderRegistry(B)
        |
        +-- runtime C
              +-- ...
```

每个 runtime 内部仍是当前系统熟悉的单 workspace 模型。multi-workspace 只存在于 serve 层的 registry、route resolution 和 status aggregation。

## WorkspaceRegistry

新增 registry 类型，建议放在 `packages/cli/src/serve/workspace-registry.ts` 或相近目录。

建议接口：

```ts
interface WorkspaceRuntime {
  readonly key: string;
  readonly isPrimary: boolean;
  readonly bridge: AcpSessionBridge;
  readonly workspaceService: DaemonWorkspaceService;
  readonly fsFactory: WorkspaceFileSystemFactory;
  readonly clientMcpSenderRegistry: ClientMcpSenderRegistry;
  close(): Promise<void>;
}

interface WorkspaceRegistry {
  readonly primary: WorkspaceRuntime;
  list(): readonly WorkspaceRuntime[];
  resolveWorkspace(input: string | undefined): WorkspaceRuntime;
  resolveRequiredWorkspace(input: string): WorkspaceRuntime;
  noteSession(sessionId: string, workspaceKey: string): void;
  forgetSession(sessionId: string): void;
  resolveSession(sessionId: string): WorkspaceRuntime | undefined;
  close(): Promise<void>;
}
```

`resolveWorkspace(undefined)` 返回 primary，兼容 legacy behavior。

`resolveRequiredWorkspace(input)` 用在 `/workspaces/:workspace/...` 这类显式 workspace route。解析失败返回 `workspace_mismatch`。

`resolveSession(sessionId)` 先查 session index，找不到时可以扫描 runtime 的 live session summary，扫描仍找不到时按现有 `session_not_found` 行为返回。

registry 只负责选择 runtime，不负责把一个请求拆散到多个 workspace。任何没有 workspace selector、也没有 session id 的旧接口，首版都必须明确 primary-only；如果确实要跨 workspace 支持，必须先增加显式索引，例如 `requestId -> workspaceKey`，不能运行时广播给所有 runtime 试探。

## Runtime 创建

从 `run-qwen-serve.ts` 和 `server.ts` 中抽出 `createWorkspaceRuntime(workspaceKey, sharedDeps)`：

1. canonicalize workspace。
2. 加载该 workspace 的 settings。
3. 构造该 workspace 的 filesystem factory。
4. 构造该 workspace 的 bridge。
5. 构造该 workspace 的 `DaemonWorkspaceService`。
6. 构造该 workspace 的 MCP sender registry、memory lane、status provider。

全局共享对象保持在 app 层：

- auth token 和 auth middleware。
- CORS、rate limiter、access logger。
- telemetry sender。
- daemon logger。
- process lifecycle handle。
- global path lock registry。当前实现已经在 bridge 和 REST filesystem factory 之间共享 path lock；多 runtime 时也应共享同一个 registry，除非启动校验能证明所有 workspace roots 和 secondary roots 完全不重叠。

workspace-scoped 对象放进 runtime：

- `AcpSessionBridge`。
- `DaemonWorkspaceService`。
- `WorkspaceFileSystemFactory`。
- workspace settings snapshot。
- workspace effective env / child env overlay。
- runtime MCP sender registry。
- runtime device-flow registry，或至少是带 workspace ownership 的 device-flow registry。
- workspace remember task lane。
- status provider 中的 child/channel state。

### Workspace Env Overlay

当前 `DaemonWorkspaceService.reload()` 通过 `reloadDaemonEnv(boundWorkspace)` 调到 `reloadEnvironment(merged, workspace)`。这个实现会把该 workspace 的 `.env` 刷进 daemon 父进程的全局 `process.env`。单 workspace 下没有歧义；多 runtime 下 A/B 两个 workspace 如果有同名 env key，就会变成 last-writer-wins，并污染后续任意 workspace 的 ACP child spawn。

多 workspace 方案必须把 env reload 从“改父进程全局 env”改成“更新目标 runtime 的 effective env / child env overlay”：

1. daemon 父进程 `process.env` 只在启动时按 primary workspace 初始化，保持单 workspace 场景行为。
2. additional workspace 加载 settings 时不要把 `.env` 写入父进程；需要新增或抽出纯计算 helper，把该 workspace 的 `.env` 差量表示成 `Record<string, string | undefined>`。
3. 每个 `WorkspaceRuntime` 持有自己的 `childEnvOverrides`，最终 ACP child spawn env = daemon 父进程 env + daemon-global child overrides + workspace child env overlay。
4. 现有 daemon-global `childEnvOverrides` 只适合 MCP budget / CDP tunnel 这类进程级 flags；多 runtime 后必须拆出 per-runtime overlay。
5. `POST /workspaces/:workspace/reload` 只重算目标 runtime 的 overlay 和 settings cache；如果该 runtime 的 ACP child 已经存活，响应里返回 `requiresChannelRestart: true`，说明新 env 只会应用到重启后的 child。
6. `GET /workspaces/:workspace/env` 返回 daemon 父进程 env 与目标 runtime overlay 合并后的视图，保持现有敏感字段处理规则。
7. daemon 父进程内执行的 workspace-scoped 操作也必须读取目标 runtime 的 effective env，例如 providers status、voice transcription、auth provider install/model resolution、workspace preflight 等。实现应把 `effectiveEnv` 显式传给这些 helpers，或让 runtime 提供 env-aware settings/provider facade；不要在 async handler 内临时改写全局 `process.env`，那会重新引入跨 workspace race。

这是多 runtime 架构下的必修项；否则 workspace reload 会跨 workspace 污染。

### Runtime Preheat

当前 daemon runtime 启动后会调用 `bridge.preheat()`，并把结果写入单个 `startup.preheat`。多 runtime 下不能直接对所有 workspace 并发 preheat：

- 全量 preheat 会在 boot 时同时 spawn 多个 ACP child，放大 CPU/RSS 冷启动峰值。
- 这也违背“idle runtime 不应强制启动 child”的目标。
- 旧 `startup.preheat` 只有一个 status/duration/error，无法表达多个 workspace 的预热结果。

首版规则：

1. 默认只 preheat primary runtime；additional runtime 一律 lazy spawn。
2. 旧 `startup.preheat` 保留 primary 语义。
3. status 可 additive 增加 `startup.workspacePreheats[]` 或等价 per-workspace 字段；primary entry 与旧字段保持一致，non-primary 显示 `not_scheduled` / `lazy`。
4. 如果后续要允许全量 preheat，必须通过显式 flag 开启，并受资源限制保护。

## 启动配置

首版使用静态 workspace 列表：

- 第一个 workspace 是 primary。
- 支持重复传 `--workspace <dir>` 或新增等价配置项来声明 additional workspaces。
- 如果只传一个 workspace，行为和现在一致。
- 不从请求体里的任意 cwd 动态创建 runtime。
- 不把 `QWEN_CODE_IDE_WORKSPACE_PATH` 里的 secondary root 自动升级成 workspace runtime。

校验规则：

1. 所有 workspace 都必须是 absolute path 并 canonicalize 成真实目录。
2. duplicate workspace 只保留一个。
3. 首版拒绝 nested workspace 列表，避免同一个 path 同时命中父子 runtime。
4. additional workspace 必须加载自己的 trust/settings 状态。
5. explicit workspace 即使 untrusted 也可以注册，但 runtime 标记为 `trusted: false`，写文件、runtime MCP mutation、memory write 等 mutating route 返回 403；implicit IDE secondary roots 仍按现有逻辑过滤 untrusted root，不自动升级成 workspace runtime。

资源边界：

- 保留现有 `maxSessions` 语义为每个 workspace runtime 的 session 上限。
- 增加 `maxTotalSessions` 作为进程级上限。若 `maxSessions` 是有限正数，默认值建议为 `maxSessions * workspaceCount`，这样单 workspace 和“原本多个 daemon”迁移过来的容量预期不变；若 `maxSessions` 为空/无限，则 `maxTotalSessions` 默认也为空/无限。用户可以显式设更低的全局上限。
- `/capabilities` 和 daemon status 必须显式区分 `maxSessionsPerWorkspace` 与 `maxTotalSessions`。旧文档里 `--max-sessions` 是进程级并发 session 上限；如果多 workspace 模式把它解释成 per-workspace 上限，就要在用户文档、兼容性说明和 changelog 中明确这是多 workspace 模式下的语义扩展。
- `maxTotalSessions` 必须在 serve/registry 层执行，而不是交给单个 runtime bridge。registry 汇总各 bridge 的 live `sessionCount`，并维护进程级 in-flight reservation。
- total cap admission 必须在“即将新建 session”边界原子占位，spawn/load/resume/branch 等 fresh session 创建失败后回滚，session close/delete 后释放。两个 workspace 并发创建 session 时不能同时越过总上限。
- attach 到已有 session 不计入 total cap，和现有 per-workspace `maxSessions` 语义保持一致。因此实现要让 bridge 在 fresh-spawn 前调用 registry admission hook，或提供等价机制；不能在 HTTP 层对所有 `spawnOrAttach` 请求一律先占位，否则 total cap 满时会错误拒绝 attach。
- total cap 拒绝语义对齐现有 session limit：HTTP 503，`Retry-After: 5`，错误码继续可被 SDK 识别为容量不足。
- 初始不支持 runtime 动态 add/remove，因此不需要 `maxWorkspaces`；实际上 workspace 数量由启动配置限制。

## Channel Workers

`qwen serve --channel` 当前假设 daemon 只有一个 workspace：worker 通过 `QWEN_DAEMON_WORKSPACE` 接收单个 workspace，supervisor 也以 `opts.workspace` 作为 worker cwd。多 workspace daemon 不能继续只校验“channel cwd 等于 primary workspace”。

首版规则：

1. selected channel 的 configured cwd 必须 canonicalize 到 registered workspace；否则启动失败并说明该 channel 不属于当前 daemon registry。
2. 如果多个 named channels 分属不同 workspaces，supervisor 按 workspace 分组启动 worker：每个 worker process 只承载同一 workspace 的 channel 集合，`QWEN_DAEMON_WORKSPACE` 和 spawn cwd 都设为该 workspace。
3. 单 workspace 或所有 selected channels 属于同一 workspace 时行为与现在等价。
4. `--channel all` 首版只展开 primary workspace 的 channels，避免一个 flag 隐式跨所有 registered workspaces 拉起进程；跨 workspace all 可以作为后续显式能力。
5. daemon status 中 channel worker snapshot 需要带 `workspaceCwd`，便于 Web Shell/SDK 按 workspace 展示。
6. channel service pidfile 当前只有 `channels[]` 和单个 `workerPid`。如果 serve supervisor 会启动多个 workspace worker，pidfile schema 也要 additive 增加 worker 列表，例如 `{ workspaceCwd, channels, workerPid }[]`；旧 `workerPid` 可继续表示 primary/单 worker 兼容字段。`qwen channel status` 按 workspace 分组展示，`qwen channel stop` 仍提示停止 owning serve process，不直接管理子 worker。

## HTTP API

### Capabilities

保持旧字段：

```json
{
  "workspaceCwd": "/repo/a"
}
```

新增 additive 字段：

```json
{
  "workspaceCwd": "/repo/a",
  "workspaces": [
    { "cwd": "/repo/a", "primary": true, "trusted": true },
    { "cwd": "/repo/b", "primary": false, "trusted": false }
  ],
  "limits": {
    "maxSessionsPerWorkspace": 20,
    "maxTotalSessions": 40
  },
  "features": ["multi_workspace"]
}
```

旧客户端继续读 `workspaceCwd`。新客户端根据 `features` 和 `workspaces` 显示 workspace picker。

兼容约束：

- `workspaceCwd` 继续表示 primary workspace，不改成“当前请求 workspace”或“任意 workspace”。
- `workspaces[]` 是新客户端判断一个 daemon 是否能服务某 workspace 的唯一列表。每个 entry 增加 `trusted`，让 workspace picker 和 SDK 可以在发起 mutation 前禁用写操作入口；不 trusted 的 workspace 仍可展示 read-only 状态。
- channel worker 这类现有消费者不能只读 `workspaceCwd` 做严格相等；多 workspace 模式下必须改为检查 requested workspace 是否存在于 `workspaces[]`。
- `/daemon/status` 同样保留旧的 `daemon.workspaceCwd` / 顶层 `workspaceCwd` primary 语义，同时新增聚合 `workspaces[]`。`runtime.sessions.active` 建议表示进程总 active sessions；如果 UI 需要按 workspace 展示，必须读 `workspaces[].sessions`，不要从旧字段反推。
- workspace-less legacy routes 继续 primary-only。已经带 workspace path 参数的 read-only legacy routes 可以放宽到 registered workspace，例如 `GET /workspace/:id/sessions`、`GET /workspace/:id/session-groups`；mutation 类 singular legacy routes 仍保持 primary-only，或要求使用 plural namespace。

Feature tag 归属规则：

- 顶层 `features[]` 仍是 daemon 级接口能力列表；其中 workspace-settings 推导的 tag 按 primary workspace 计算，保持旧客户端兼容。
- 当前需要特别处理的 workspace-settings 推导 tag 是 `workspace_voice_transcription`：`createServeFeatures()` 通过 `loadSettings(boundWorkspace)` 和模块级缓存计算它。多 workspace 下不能让 non-primary 的 settings 事件翻转 primary 的顶层 tag。
- workspace-specific 的权威判断不从顶层 `features[]` 读取。新客户端应读取 `workspaces[]`、`GET /workspaces/:workspace/status` 或 voice status 这类 workspace-qualified status；后续如果需要，也可以把 per-workspace feature tags additive 镜像到 `workspaces[]` entry。
- `invalidateServeFeaturesCache` 必须按 owning workspace 过滤。只有 primary workspace 的 `settings_changed` / `settings_reloaded` / legacy `POST /workspace/reload` 才失效顶层 feature cache；`POST /workspaces/:workspace/reload` 只失效目标 runtime 的 workspace status / voice status cache。
- 新增 feature tag 时要盘点归属：opts/deps/process 级 tag 继续 daemon-wide；settings-derived tag 必须明确是 primary-derived 顶层 tag，还是 per-workspace status 字段。

### Session 创建

保留：

```http
POST /session
```

行为：

- body 不传 `cwd`：使用 primary runtime。
- body 传 `cwd`：canonicalize 后必须命中 registered workspace。
- 命中哪个 workspace，就调用哪个 runtime 的 `bridge.spawnOrAttach`。
- 创建成功后 registry 记录 `sessionId -> workspaceKey`。

错误：

```json
{
  "error": "workspace_mismatch",
  "requestedWorkspace": "/repo/x",
  "boundWorkspace": "/repo/a",
  "boundWorkspaces": ["/repo/a", "/repo/b"]
}
```

保留 `boundWorkspace` 指向 primary，兼容旧错误解析；新增 `boundWorkspaces` 给新客户端。

### Workspace-qualified routes

新增 plural namespace，避免和现有 `/workspace/memory`、`/workspace/settings` 等 legacy route 冲突：

```http
/workspaces/:workspace/...
```

`:workspace` 首版使用 `encodeURIComponent(canonicalCwd)`。这和现有 SDK 的 `/workspace/:id/sessions` 风格一致，避免额外引入 opaque id。

解析规则必须集中在一个 helper 内：

- Express 解码后的值必须是 absolute path，且长度不能超过现有 workspace path 上限。
- canonicalize 后必须精确命中 registry；未知 workspace 返回 `workspace_mismatch`。
- 不允许 prefix / startsWith 判断 workspace 归属，nested workspace 首版已在启动时拒绝。
- plural namespace 的具体 routes 必须在 catch-all routes 之前注册；SDK 的 ACP route table 也要同步增加 `/workspaces/:workspace/...` pattern，避免新客户端经 HTTP fallback 时仍走 singular legacy path。
- rate-limit tier 解析要显式识别 plural namespace，并继承同语义 singular route 的档位。实现上可以先解析 `/workspaces/:workspace` 前缀，再对剩余 path 复用现有 tier 规则：写文件、settings、tools、lifecycle 等 mutation 仍是 `mutation`，sessions/status/list/file read 仍是 `read`，未来如果出现 workspace-qualified prompt 类 route 必须归入 `prompt`。不要让新 plural route 只依赖 fallback 行为而和旧 route 档位分裂。

推荐新增或镜像的 route：

- `GET /workspaces/:workspace/sessions`
- `GET /workspaces/:workspace/session-groups`
- `GET /workspaces/:workspace/status`
- `GET /workspaces/:workspace/file`
- `POST /workspaces/:workspace/file`
- `GET /workspaces/:workspace/list`
- `GET /workspaces/:workspace/glob`
- `GET /workspaces/:workspace/memory`
- `POST /workspaces/:workspace/memory`
- `GET /workspaces/:workspace/agents`
- workspace-scoped settings、trust、permissions、voice、tools、auth、mcp、lifecycle routes

workspace-less legacy routes 继续保留，并绑定 primary：

- `/workspace/...`
- `/file`
- `/list`
- `/glob`
- `/session` without `cwd`
- `/acp`

现有已参数化的 read-only legacy route 可以继续支持 registered workspace，例如 `GET /workspace/:id/sessions` 和 `GET /workspace/:id/session-groups`。对应 mutation routes 不放宽：`POST/PATCH/DELETE /workspace/:id/session-groups` 保持 primary-only，非 primary 使用 `/workspaces/:workspace/...`。新 SDK 应优先调用 plural namespace，避免继续扩大 singular namespace 语义。

### Session-scoped routes

`/session/:id/...` 这类 route 不需要客户端重复传 workspace。服务端通过 registry 的 `sessionId -> workspaceKey` 找 runtime。

处理细节：

1. 推荐由 registry 订阅或注入 bridge 的 session lifecycle callback，集中维护 `noteSession` / `forgetSession`。bridge 每次注册或移除 live session 时上报 owning workspace，REST route 和 ACP dispatcher 都不需要手工填索引。
2. 如果实现阶段暂时无法改 bridge callback，索引填充点也必须覆盖所有 session 创建路径，不只 REST route；至少包括 `POST /session`、load、resume、fork、branch，以及各 runtime-bound ACP dispatcher 内部的 `session/new`、load、resume 处理。
3. session close、delete、bridge 返回 not found 后调用 `forgetSession`。child crash 后的 stale index 可以惰性清理：下次按索引命中 runtime 但 bridge 返回 not found 时再 forget。
4. 如果 index 缺失，扫描 runtime live sessions 做 fallback。
5. 如果多个 runtime 同时报告相同 session id，返回 server error 并记录高优先级日志；session id 理论上应全局唯一。

必须纳入 session-scoped 分发的接口包括但不限于：

- `GET /session/:id/events`：先按 session id 解析 runtime，再订阅该 runtime bridge 的 event bus。
- `POST /session/:id/permission/:requestId`：按 session runtime 投票。
- `POST /session/:id/a2ui-action`：按 session runtime 查询 workspace MCP status 和 settings fallback。
- `PATCH /session/:id/organization`：按 session runtime 使用对应 workspace 的 `SessionService` 和 organization store。
- artifacts、metadata、cancel、prompt、load/resume/fork/branch/delete 等现有 session routes。

现有 `POST /permission/:requestId` 没有 session id，也没有 workspace selector。首版保持 legacy primary-only，或在实现前新增明确的 `permissionRequestId -> runtime` 索引；不能把同一个 vote 广播给多个 bridge。

persisted-only session 操作要额外小心：`load/resume` 现有 body 可以传 `cwd`，新 SDK 必须继续传；`GET /session/:id/export` 这类没有 workspace selector 的 GET route 首版保持 primary-only，非 primary 需要新增 `/workspaces/:workspace/session/:id/export` 或等价 workspace-qualified route。不要用“扫描所有 workspace 的 session storage”作为默认行为。

### ACP HTTP

保留现有：

```http
/acp
```

绑定 primary runtime，保证旧 Web Shell 和旧客户端不变。

新增：

```http
/workspaces/:workspace/acp
```

绑定对应 workspace runtime 的 bridge、fsFactory 和 MCP sender registry。

不建议首版让单 `/acp` 根据 JSON-RPC body 动态分发，因为 ACP transport 当前不是纯 workspace-scoped REST API，初始化、反向 MCP、WebSocket 生命周期都需要稳定归属。

ACP dispatcher 约束：

- 每个 mounted dispatcher 都是 runtime-bound。JSON-RPC params 里的 `workspaceCwd` 只能作为一致性校验；如果和 mount path 对应 runtime 不一致，返回 `workspace_mismatch`。
- dispatcher 内部镜像了 REST 的大量 workspace 能力，包括 file、workspace permissions、voice、setup-github、auth device-flow、session groups、batch sessions、runtime MCP、agents 和 extensions；这些能力必须随 dispatcher 实例使用目标 runtime 的 bridge/service/fsFactory/device-flow registry。
- `/acp` legacy dispatcher 继续绑定 primary。新 Web Shell 必须连 `/workspaces/:workspace/acp`，不要指望单 `/acp` 在连接内切换 workspace。
- `/workspaces/:workspace/acp` 是 WebSocket upgrade path，不会天然经过 Express route。HTTP server 的 `upgrade` listener 必须解析 URL path、resolve workspace，再把 socket 分发给目标 runtime-bound dispatcher；只注册 Express route 不够。

### Event、Auth 和 Voice Surfaces

SSE、auth device-flow、voice WebSocket 是多 workspace 容易漏掉的旁路：

- workspace events 必须由目标 runtime bridge 发布，并在事件体保留 `workspaceCwd`。聚合 UI 不能把不同 workspace 的 `settings_changed`、`auth_device_flow_*`、`extensions_changed` 等事件合并成单一 workspace 状态。
- device-flow registry 不能继续作为 app-global 单例绑定 primary bridge。推荐每个 runtime 持有自己的 registry；如果实现选择共享 registry，则每条 flow 必须记录 owning workspace，并通过 owning runtime 的 bridge 发布事件。`GET/DELETE /workspaces/:workspace/auth/device-flow/:id` 必须拒绝或隐藏不属于该 workspace 的 flow。
- auth provider install callback 也必须 runtime-scoped。当前实现对 `boundWorkspace` 加 settings lock 并写入 provider 配置；workspace-qualified `/workspaces/:workspace/auth/provider` 必须写目标 runtime workspace，legacy `/workspace/auth/provider` 才写 primary。
- cleanup 不能只通过 `app.locals.deviceFlowRegistry` dispose 一个 registry；shutdown 时 registry/runtime 统一关闭所有 workspace registries。
- `/voice/stream` WebSocket 现在闭包固定 `boundWorkspace`。legacy `/voice/stream` 保持 primary-only；新增 `/workspaces/:workspace/voice/stream` 时 handler 必须由 registry 解析 workspace 后加载目标 settings/model。
- `/workspaces/:workspace/voice/stream` 同样是 HTTP server 级 `upgrade` 分发，不会自动走 Express middleware；upgrade listener 要先做 auth/host/CORS 等现有校验，再按 URL 解析 workspace 并调用目标 runtime 的 voice handler。
- voice WebSocket 的并发保护当前在 handler closure 内。多 workspace 挂多个 handler 时要保留进程级总 cap，或者显式增加 per-workspace + total 两层 cap；不能无意变成每个 workspace 都有一份独立总量。

## Route 迁移策略

首版不要求一次性重写所有 route。推荐按以下顺序落地：

1. 引入单 runtime `WorkspaceRegistry`，保持所有测试通过，无行为变化。
2. Phase 2a 只做 static multi-workspace session closed loop：`POST /session` 支持 `cwd` 路由到 registered workspace，并同批完成 session-scoped runtime dispatch。prompt、events、cancel、permission vote、model/mode、metadata/status/tasks、A2UI、organization 等 `/session/:id/...` route 必须按 `sessionId -> runtime` 命中目标 bridge。
3. Phase 2a 同批交付 capabilities/status registry 视图、`maxTotalSessions` admission 和 per-runtime env overlay。非闭环所需的 workspace API 首版可以继续 primary-only 或返回明确 unsupported / `workspace_mismatch`，不要半支持。
4. Phase 2b/3 再增加 `GET /workspaces/:workspace/sessions`、参数化 read-only legacy session routes 和 persisted session storage 的 workspace-qualified route，例如 export、batch delete/archive/unarchive。
5. 文件 routes 增加 workspace-qualified 版本。
6. memory、agents、settings、trust、permissions、tools、lifecycle、mcp、auth、voice、extensions routes 增加 workspace-qualified 版本。
7. `/workspaces/:workspace/acp` 支持 workspace-specific Web Shell。

每一步都保持 workspace-less legacy routes primary-only。已经自带 workspace
参数的 read-only legacy routes 可以按兼容规则解析 registered workspace；
mutation 类 singular legacy routes 不放宽。

## Filesystem

不要把已有 `boundWorkspaces: string[]` 直接当作 multi-workspace runtime。

推荐模型：

- 每个 workspace runtime 有自己的 filesystem factory。
- 该 factory 的第一个 root 是 runtime workspace cwd。
- 如果 IDE multi-folder roots 属于同一个 runtime，可以作为 secondary roots 加入这个 factory。
- REST legacy `/file` 继续使用 primary runtime factory。
- `/workspaces/:workspace/file` 使用选中 runtime factory。

file response 应新增 `workspaceCwd` 字段，避免新客户端只根据 relative path 判断来源：

```json
{
  "workspaceCwd": "/repo/b",
  "path": "src/index.ts",
  "absolutePath": "/repo/b/src/index.ts"
}
```

如果后续需要在同一 workspace runtime 内暴露 secondary roots 的相对 path，应再引入 `rootId`，不要把这个问题混进首版 multi-workspace daemon。

## Settings、Trust 和 Permissions

每个 runtime 独立加载 workspace settings。原因：

- permission policy 可能按 workspace 不同。
- context filename、custom ignore、disabled tools、provider config 可能按 workspace 不同。
- trust 状态和 writable filesystem boundary 必须跟 workspace 绑定。

请求处理规则：

- legacy route 使用 primary settings。
- workspace-qualified route 使用目标 runtime settings。
- 如果 workspace 不 trusted，写文件、运行可能修改 workspace 的 tool、runtime MCP mutation、memory write 应拒绝。
- read-only 状态类接口可以返回明确 `trusted: false`。
- user-scope settings 写入要按目标 settings 文件路径加锁，而不是按 workspace path 加锁。否则两个 runtime 同时写 `~/.qwen/settings.json` 会绕过单进程锁。workspace-scope settings 可以继续按 workspace 文件路径锁。

## MCP 和 Client Tools

Runtime MCP 与 client-provided MCP 都按 workspace runtime 隔离。

原因：

- client tool 的可见文件、浏览器上下文、CDP tunnel 可能和 workspace 强相关。
- runtime MCP add/remove 是 workspace-level mutation，不应影响其他 workspace。
- 把 MCP sender registry 做成全局对象会让 sessionless MCP 请求难以判定归属。

因此 `/workspaces/:workspace/acp` 和 workspace-qualified MCP routes 都使用目标 runtime 的 `ClientMcpSenderRegistry`。

## Session Storage

当前 `SessionService(workspaceCwd)` 已按 workspace 分区，推荐继续沿用。

改动点：

- session list route 不再只允许 `workspaceCwd === boundWorkspace`。
- delete/load/resume 等持久化操作需要先解析 workspace。
- 不传 workspace 的 legacy 操作只查 primary，避免一次请求误删多个 workspace 的 session。
- 新增 workspace-qualified session storage routes，用于非 primary workspace。
- `POST /sessions/delete`、`POST /sessions/archive`、`POST /sessions/unarchive` 这些没有 workspace selector 的 batch route 首版保持 primary-only；非 primary 需要新增 `/workspaces/:workspace/sessions/delete|archive|unarchive`。
- `PATCH /session/:id/organization` 虽然是 session-scoped，但会读写 workspace organization sidecar，因此必须通过 registry 找到 session 所属 runtime 后再实例化 `SessionService(workspaceCwd)` 和 `SessionOrganizationService(workspaceCwd)`。
- `GET/POST/PATCH/DELETE /workspaces/:workspace/session-groups` 操作目标 workspace 的 group store。旧 `/workspace/:id/session-groups` 可以兼容保留，但新 SDK 使用 plural namespace。
- `GET /session/:id/export` 等只靠 session id 读取 persisted transcript 的 legacy GET route 保持 primary-only；非 primary 通过 workspace-qualified route 调用。
- 批量 archive/delete 不能按 session id 在所有 runtimes 中扫描后执行，除非请求显式声明允许跨 workspace 且返回按 workspace 分组的结果；首版不做这个能力。

## Observability

新增观测维度：

- access log 增加 resolved workspace，无法解析时记录 requested workspace。
- daemon status 返回 per-workspace summary。
- telemetry 里使用 workspace hash 作为低基数标签；HTTP response 可以继续返回 cwd。
- HTTP telemetry middleware 不能在注册时只闭包捕获 primary `workspaceHash`。workspace-qualified routes 应在 route resolution 后把 resolved workspace 写入 request context / `res.locals`，span 和 metrics 再读取该属性；session-scoped routes 通过 session registry 填充 workspace，未知/解析失败时记录 `workspace=unknown` 和 requested value。
- daemon gauge callbacks 不能闭包捕获单个 bridge。`sessionCount` 等 gauge 应通过 registry 聚合所有 runtimes。
- `PermissionAuditRing` 可以继续 daemon-wide，但 entry 需要带 workspace；如果选择 per-runtime ring，daemon status 再聚合。
- child RSS/CPU 采样不能只轮询一个 child。status 图表需要定义 total 聚合值，同时 full status 可以返回 per-workspace child resource。
- bridge child exit、spawn failure、workspace mismatch、duplicate session id 都带 workspace key。
- daemon 日志文件名、daemon logger id 和 telemetry service id 不能再绑定单一 workspace hash。多 workspace 模式建议日志文件使用 `serve-<pid>.log`，`latest` symlink 语义保持不变；daemon id / telemetry service id 使用 `daemon:<pid>` 这一类 daemon-scoped 标识。workspace hash 降级为日志行字段和 span/metric attribute。落地前需要确认没有下游依赖 `serve-<pid>-<workspaceHash>.log` 文件名解析 workspace。

`GET /daemon/status` 建议返回：

```json
{
  "status": "ok",
  "workspaceCwd": "/repo/a",
  "workspaces": [
    {
      "cwd": "/repo/a",
      "primary": true,
      "bridge": { "state": "connected" },
      "sessions": { "live": 2 }
    },
    {
      "cwd": "/repo/b",
      "primary": false,
      "bridge": { "state": "idle" },
      "sessions": { "live": 0 }
    }
  ]
}
```

旧字段保持 primary 语义。

status 聚合规则：

- `full.workspace` 如需保留，表示 primary workspace 的旧形状；新增 `full.workspaces` 或顶层 `workspaces` 才表示全量 registry。
- 单个 workspace 的 MCP/status/env 等 section 超时，只把该 workspace 标成 degraded/unavailable；daemon 总状态可降级，但其他 workspace 的 sections 仍应返回。
- auth pending count、SSE active count、ACP connection count、session count 等进程级指标要明确是 total；需要分 workspace 展示时新增 per-workspace 字段。
- channel worker snapshot 如果拆成多个 worker，status 要返回数组或按 workspace 分组；旧单对象可以继续表示 primary worker。

## 容量与已知限制

- v1 rate limiter 仍是 daemon 进程级。一个 workspace 的高流量客户端可能耗尽全局配额，影响其他 workspace；这不是 workspace 隔离配额。需要 per-workspace 公平性时后续再引入 workspace-aware rate limiter。
- `maxTotalSessions` 是进程级硬上限，`maxSessionsPerWorkspace` 是单 workspace 上限。部署方做容量规划时应同时看两个值。
- v1 不支持 dynamic workspace add/remove，因此 workspace 数量由启动配置决定。

## Failure Paths

### Workspace mismatch

请求指定未知 workspace 时返回 `400 workspace_mismatch`。不要自动创建 runtime。

### Workspace removed from disk

runtime 创建时已 canonicalize。运行中目录被删除时：

- 已存在 session 可以由 child 自己报错或退出。
- 新建 session、文件操作、settings reload 应返回明确 filesystem error。
- daemon 不应悄悄把 workspace 从 registry 删除，避免 session 路由失效。

### Child crash

每个 runtime 独立处理 child crash。一个 workspace 的 child crash 不影响其他 workspace。

### Global shutdown

daemon shutdown 时 registry 并发关闭所有 runtime。关闭错误聚合记录，但继续尝试关闭剩余 runtime。

### Session index stale

session index stale 时 fallback 扫描 runtime live sessions。若扫描仍找不到，返回现有 session not found。不要因为 stale index 直接向错误 workspace 发送 prompt。

## SDK 变更

保持现有 API：

- `client.createSession({ workspaceCwd })`
- `client.listWorkspaceSessions(workspaceCwd)`

新增：

- `client.listWorkspaces()`
- `client.getWorkspaceClient(workspaceCwd)`
- `workspaceClient.createSession()`
- `workspaceClient.listSessions()`
- `workspaceClient.files.read(...)`
- `workspaceClient.memory.*`
- `workspaceClient.acpUrl`

旧 `DaemonClient` 的 workspace-less file helpers 继续 primary-only。新代码应通过 `WorkspaceDaemonClient` 调用 workspace-qualified routes。

## 公开文档与兼容公告

Phase 2 摘除 multi-workspace feature gate 的 PR 必须同批更新公开文档，避免行为已经启用但文档仍承诺“一个 workspace 一个 daemon”。

至少覆盖：

- `docs/users/qwen-serve.md`：CLI flags 表中说明 `--workspace` 可重复；`--max-sessions` 在 multi-workspace 模式下是 per-workspace 上限，并区分 `maxSessionsPerWorkspace` / `maxTotalSessions`；改写 “Multi-session & multi-workspace deployment” 小节，说明单 daemon 多 workspace runtime、primary workspace、legacy route primary-only 和容量规划。
- `docs/developers/qwen-serve-protocol.md`：更新 `/capabilities` schema，包含 `workspaces[]`、`workspaces[].trusted`、`limits`、`multi_workspace` feature tag；更新 `workspace_mismatch` 错误体与 `boundWorkspaces` / registered workspace 语义；补 plural `/workspaces/:workspace/...` route 参考。
- `docs/developers/examples/daemon-client-quickstart.md`：把“multi-workspace deployments run one daemon per workspace”改成优先使用 multi-workspace daemon 的 workspace picker / `WorkspaceDaemonClient`，保留多 daemon 作为 fallback。
- `docs/users/qwen-serve-deploy-local.md`：更新 “Cross-host federation / multi-daemon coordination on one host” 限制说明，把 multi-daemon 降级为 fallback / federation 形态，而不是唯一 multi-workspace 部署方式。
- 全仓公开文档里其他“one daemon = one workspace”承诺也要一起扫掉或降级为 legacy/fallback 描述，例如 `docs/developers/daemon/*` 和 channel adapter 文档中的 daemon workspace 定义。
- changelog / 兼容性小节：显式记录 `--max-sessions` 语义扩展、`maxTotalSessions`、workspace-qualified routes、feature gate 摘除条件。

## 测试策略

优先写窄单测，避免从 root 运行整套测试。

建议覆盖：

1. registry canonicalize、duplicate、nested rejection、primary fallback。
2. `POST /session` omitted cwd 使用 primary，非 primary cwd 路由到对应 bridge，未知 cwd 返回 `workspace_mismatch`。
3. Phase 2a session closed loop：非 primary session 创建后，prompt、events、cancel、permission vote、model/mode 等 `/session/:id/...` route 都命中目标 runtime。
4. session index 命中、stale fallback、not found。
5. Phase 2a 以外的 workspace API 在未实现 plural route 前保持 primary-only 或返回明确 unsupported / `workspace_mismatch`。
6. parameterized read-only legacy `GET /workspace/:id/sessions` / `session-groups` 接受 registered workspace；对应 mutations 不放宽。
7. legacy workspace-less `/workspace/...` 和 `/file` 仍只作用 primary。
8. workspace-qualified file route 使用目标 runtime fsFactory。
9. daemon status 聚合多个 runtime，不因 idle runtime 强制启动 child。
10. preheat 默认只作用 primary；non-primary runtime 保持 lazy，status 能表达 per-workspace preheat 状态。
11. `/workspaces/:workspace/acp` 使用目标 runtime 的 bridge 和 MCP sender registry。
12. workspace reload 不改写父进程 `process.env`；两个 workspace 有同名 `.env` key 时，各自 ACP child 和 daemon-side workspace helpers 都看到各自 overlay。
13. Phase 2a 中 channel workers 保持 primary-only，或在 multi-workspace + non-primary channel 选择时 boot error；worker 分组、pidfile 和 status 后续单独落地。
14. capabilities/status 同时返回 `maxSessionsPerWorkspace` 和 `maxTotalSessions`。
15. `maxTotalSessions` admission 在并发跨 workspace 创建时原子占位，spawn 失败回滚，attach 不计数，拒绝为 503 + `Retry-After: 5`。
16. `GET /session/:id/events`、`POST /session/:id/permission/:requestId`、`POST /session/:id/a2ui-action` 按 session id 命中目标 runtime；无 session 的 `POST /permission/:requestId` 保持 primary-only 或命中显式 request index。
17. device-flow start/get/cancel 在两个 workspace 同时存在时，事件只发给 owning runtime，跨 workspace 查询不泄露 verification fields。
18. Phase 2a 中 `/voice/stream` primary-only；`/workspaces/:workspace/voice/stream` 在 upgrade dispatcher ready 后单独落地，并使用目标 workspace settings；voice 并发 cap 不随 workspace 数量无意放大。
19. ACP dispatcher 下 `_qwen/workspace/*` body 里的 `workspaceCwd` 只能匹配 mounted workspace；不匹配返回 `workspace_mismatch`。
20. 后续 `/workspaces/:workspace/sessions/delete|archive|unarchive` 只操作目标 workspace；legacy `/sessions/*` 只操作 primary。
21. SDK `acpRouteTable`、`DaemonClient` workspace helpers 使用 plural `/workspaces/:workspace/...`，legacy singular path 只保留兼容。
22. 后续 serve-managed channel pidfile 能表达多个 workspace workers，`qwen channel status` 按 workspace 分组展示，旧单 worker 字段保持兼容。
23. HTTP telemetry 对 workspace-qualified、session-scoped、unknown workspace 请求分别打正确 workspace/unknown 属性，不再全部使用 primary hash。
24. auth provider install 在 non-primary workspace 下写目标 workspace settings，legacy route 仍写 primary。
25. `load/resume` 非 primary persisted session 必须传 workspace，`export` 等无 selector 的 persisted session GET 保持 primary-only，并提供 workspace-qualified 替代 route。
26. daemon-side provider/voice/preflight/auth helpers 使用目标 runtime effective env，不允许 async 临时改写 `process.env`。
27. daemon metrics gauge、permission audit ring、child resource sampler 都能聚合或标记 workspace。
28. user-scope settings 写入按 settings 文件路径串行化；v1 rate limiter 明确保持进程级。
29. capabilities 顶层 `features[]` 按 primary workspace 推导；non-primary settings/reload 不会失效或翻转 primary feature cache；workspace-specific voice 判断走 workspace status。
30. capabilities `workspaces[]` entry 返回 `trusted`，untrusted workspace 的 mutation route 仍返回 403。
31. 后续 `/workspaces/:workspace/acp` 和 `/workspaces/:workspace/voice/stream` 的 HTTP server upgrade listener 能解析 workspace 并分发到目标 runtime。
32. Phase 2a 未全部落地前，传入多个 `--workspace` 直接 boot error；最后摘掉门闩时再跑完整 Phase 2a 验收。
33. ACP dispatcher `session/new`、load、resume 创建的 session 会进入 registry session index；随后 REST 侧 export、organization、telemetry workspace 归属不依赖 fallback 扫描。
34. plural `/workspaces/:workspace/...` route 的 rate-limit tier 与同语义 singular route 一致：read 归 `read`，mutation 归 `mutation`，prompt 类归 `prompt`。
35. Phase 2a 摘除 feature gate 的 PR 同批更新用户文档、协议文档、quickstart、local deploy 文档和 changelog，不再残留“1 daemon = 1 workspace”作为唯一部署方式。

验收命令按变更范围选择，例如：

```bash
cd packages/cli && npx vitest run src/serve/server.test.ts
cd packages/cli && npx vitest run src/serve/run-qwen-serve.test.ts
cd packages/cli && npx vitest run src/serve/routes/session.test.ts
npm run build && npm run typecheck
```

如果涉及 TUI/Web Shell 行为，再补 E2E 计划到 `.qwen/e2e-tests/`。

## 分阶段落地计划

### Phase 1：单 runtime registry，无行为变化

- 新增 `WorkspaceRegistry` 和 `WorkspaceRuntime`。
- `createServeApp` 内部把现有单 bridge/service/fsFactory 包成 primary runtime。
- route 仍可暂时读 primary runtime，但不再直接依赖裸 `boundWorkspace`。
- 所有现有 daemon 测试应保持不变。

### Phase 2a：静态多 workspace session closed loop

- Phase 2a 可以拆成多个 PR，但在全部子项落地前必须保留 feature gate：当启动参数传入多个 `--workspace` / explicit workspace 时直接 boot error，提示 multi-workspace 尚未启用。这样中间态不会暴露半启用 daemon；最后一个 PR 摘掉门闩，并附完整 Phase 2a 验收。
- `run-qwen-serve` 接收多个 explicit workspace。
- 启动时创建多个 runtime。
- `/capabilities` 和 `/daemon/status` 暴露 `workspaces`。
- `/capabilities` 和 status 暴露 `maxSessionsPerWorkspace` / `maxTotalSessions`。
- `/capabilities` 顶层 `features[]` 保持 daemon/primary 语义，`workspaces[]` entry 带 `trusted`。
- `POST /session` 根据 body cwd 选择 runtime，并完成 `/session/:id/...` session-scoped dispatch 最小闭环，使非 primary session 可直接 prompt、订阅 events、cancel、处理 permission，并切换 model/mode 等 session-scoped state。
- session index 由 bridge lifecycle callback 集中维护，覆盖 REST 和 ACP dispatcher 的所有 session 创建路径。
- `maxTotalSessions` admission 在 registry 层执行。
- preheat 默认只作用 primary；non-primary lazy spawn。
- env reload 改为 per-runtime effective env / child env overlay，不再从非 primary workspace 改写 daemon 父进程 `process.env`；daemon-side workspace helpers 也读取 runtime effective env。
- daemon log / daemon id / telemetry service id 改成 daemon-scoped，workspace hash 只作为属性。
- Phase 2a 不要求所有 workspace APIs 多 workspace 化。非 session closed-loop 必需的 legacy routes 继续 primary-only；未实现的 non-primary surface 返回明确 unsupported / `workspace_mismatch`。
- `/acp` 和 `/voice/stream` 在 Phase 2a 继续 primary-only；workspace-qualified WebSocket routing 后续单独落地。
- daemon-managed channel workers 在 Phase 2a 继续 primary-only，或对 multi-workspace + non-primary channel 选择直接 boot error；worker grouping、pidfile 和 status 后续单独落地。
- 摘除 feature gate 的同一个 PR 必须更新公开文档和 changelog，不能让文档继续声明唯一形态是“一个 workspace 一个 daemon”。

### Phase 2b：基础 workspace-qualified reads

- 新增 `/workspaces/:workspace/sessions`；参数化 read-only legacy session routes 可读取 registered workspace。
- rate-limit tier 映射覆盖 `/workspaces/:workspace/...` plural routes，并继承同语义 singular route 的档位。
- 对已实现的 read-only plural routes 返回目标 runtime 视图；其他 plural routes 继续不暴露或返回明确 unsupported。

### Phase 3：workspace-qualified REST

- persisted session storage 的 workspace-qualified route，例如 export、batch delete/archive/unarchive。
- 文件、memory、agents、settings、trust、permissions、tools、lifecycle、mcp、auth、voice、extensions routes 增加 plural namespace。
- legacy 无 workspace selector 的 batch sessions、permission shortcut、voice stream 保持 primary-only。
- workspace-less legacy routes primary-only；已参数化的 read-only legacy
  session routes 继续按兼容规则支持 registered workspace。
- SDK 增加 `WorkspaceDaemonClient`。

### Phase 4：workspace-qualified ACP

- 挂载 `/workspaces/:workspace/acp`。
- 每个 ACP dispatcher/runtime 持有自己的 bridge、fsFactory、client MCP sender registry、device-flow registry。
- Web Shell 从 capabilities 读取 workspace picker。
- reverse MCP/CDP 连接按 workspace runtime 隔离。

### Phase 4b：channel workers 和 voice workspace 化

- daemon-managed channel workers 按 workspace 校验和分组；`--channel all` 首版 primary-only。
- serve-owned channel pidfile additive 记录 workspace worker 列表，`qwen channel status` 能展示分组。
- `/workspaces/:workspace/voice/stream` 使用目标 workspace settings，并保留进程级总 cap 或显式设计 per-workspace + total 两层 cap。

### Phase 5：可选动态 workspace

仅在前四阶段稳定后考虑：

- authenticated admin API 添加 workspace。
- runtime lazy create。
- max workspace 数量限制。
- runtime drain/remove。

动态 workspace 会扩大安全和资源管理面，首版不建议做。

## 审计记录

### 审计 1：架构边界

发现问题：如果直接把 `AcpSessionBridge` 改成多 workspace map，会同时改动 default session、channel lifecycle、spawn coalescing、list sessions、status snapshot 和 close 语义，风险集中且难以逐步验证。

调整：推荐一个 daemon 多 runtime，每个 runtime 继续用单 workspace bridge。multi-workspace 只放在 serve registry 和 route resolution 层。

### 审计 2：API 兼容性

发现问题：继续扩展 `/workspace/:id/...` 会和已有 `/workspace/memory`、`/workspace/settings` 等 singular legacy routes 叠加语义，route order 容易出错。

调整：新 workspace-qualified API 使用 `/workspaces/:workspace/...` plural namespace。旧 `/workspace/...` 保持 primary-only。现有 `/workspace/:id/sessions` 可以兼容保留，但新 SDK 不再扩展它。

### 审计 3：安全与失败路径

发现问题：如果请求体里未知 cwd 自动创建 workspace runtime，任何有 token 的客户端都能扩大 daemon 文件边界和资源占用。

调整：首版只支持启动时静态注册 workspace。未知 cwd 返回 `workspace_mismatch`。资源上增加 `maxTotalSessions`，trust 按 workspace 独立校验。

### 审计 4：复杂度

发现问题：同时做 route namespace、bridge 内部多 workspace、dynamic add/remove、opaque workspace id 会让首版过大。

调整：首版不引入 opaque id，不做 dynamic workspace，不改 ACP child 多 cwd 协议。先用 canonical cwd 作为 key，保留现有 URL encoding 风格。

### 审计 5：测试可验证性

发现问题：如果第一步就启用多 workspace，回归失败很难判断来自 registry 抽象还是多 workspace 行为。

调整：Phase 1 只引入单 runtime registry，要求完全无行为变化。Phase 2a 再开启 static multi-workspace session closed loop、capabilities/status、total admission 和 env isolation。

### 审计 6：资源与写隔离

发现问题：多 runtime 后如果每个 runtime 使用独立 path lock registry，重叠 root、symlink 或后续 secondary roots 可能绕过现有 bridge/REST 写串行保护；同时，显式配置的 untrusted workspace 若直接导致 daemon 启动失败，会比现有单 workspace trust 行为更生硬。

调整：path lock registry 保持进程级共享；explicit untrusted workspace 仍注册但标记为 `trusted: false`，mutating route 返回 403，implicit IDE secondary roots 继续按现有逻辑过滤。

### 审计 7：父进程全局状态

发现问题：`reloadDaemonEnv` 当前会把某个 workspace 的 `.env` 刷进 daemon 父进程 `process.env`。多 runtime 共享同一个父进程，workspace A/B 的同名 key 会 last-writer-wins，并污染后续 child spawn。

调整：multi-workspace 模式下 env reload 必须转成 per-runtime effective env / child env overlay。父进程 env 只按 primary 初始化；`POST /workspaces/:workspace/reload` 只重算目标 overlay，必要时提示 channel restart；daemon-side workspace helpers 也必须读目标 runtime effective env。

### 审计 8：运维标识与 channel worker

发现问题：daemon 日志文件名、daemon logger id、telemetry service id、`--channel` worker 目前都隐含单 workspace。多 workspace daemon 没有唯一 workspace hash；一个 worker process 也只能携带一个 `QWEN_DAEMON_WORKSPACE`。

调整：多 workspace 模式使用 daemon-scoped log/daemon/service id，workspace hash 作为属性；channel worker 按 workspace 分组启动，`--channel all` 首版 primary-only。

### 审计 9：旁路事件与无 workspace selector 接口

发现问题：`GET /session/:id/events`、permission vote、A2UI action、session organization 都不是 `/workspaces/:workspace/...` 形态，但内部仍依赖 bridge、workspace MCP status、settings 或 workspace sidecar store。尤其 `POST /permission/:requestId` 没有 session id，不能通过 session registry 定位 runtime。

调整：所有带 session id 的旁路接口按 `sessionId -> runtime` 分发；无 session id 的 legacy permission shortcut 首版 primary-only，除非先引入 `requestId -> runtime` 显式索引。

### 审计 10：auth device-flow

发现问题：device-flow registry 的 event sink 当前绑定单个 bridge。多 runtime 如果复用 primary registry，非 primary workspace 的 auth 完成/失败事件会发错 workspace，查询也可能看到其他 workspace 的 pending flow。

调整：device-flow registry 归入 runtime，或共享 registry 记录 owning workspace 并按 owning runtime 发布事件。workspace-qualified auth route 只能访问本 workspace 的 flow；shutdown 要 dispose 全部 runtime registries。

### 审计 11：voice WebSocket

发现问题：`/voice/stream` 的 WebSocket handler 闭包固定 `boundWorkspace`，且并发计数在 handler closure 内。多 workspace 如果直接挂多个 handler，会把进程级保护放大成每 workspace 一份。

调整：legacy `/voice/stream` primary-only；新增 workspace-qualified voice stream 时按 registry 选择 runtime，并保留进程级总 cap 或显式设计 per-workspace + total 两层 cap。

### 审计 12：ACP dispatcher 镜像面

发现问题：ACP dispatcher 内部镜像了 REST 的 workspace/auth/voice/session storage/runtime MCP/file 等能力。如果只给 REST route 加 workspace selector，Web Shell 经 ACP 仍会打到 primary-bound dispatcher。

调整：每个 `/workspaces/:workspace/acp` mount 创建 runtime-bound dispatcher；JSON-RPC params 里的 `workspaceCwd` 只做一致性校验，不能在同一 dispatcher 内切 runtime。SDK route table 也要同步新增 plural path。

### 审计 13：status 聚合与旧字段语义

发现问题：`/capabilities`、`/daemon/status` 和 SDK types 目前都把 `workspaceCwd` 当成 daemon 唯一 workspace。多 workspace 下如果不显式区分 primary、total 和 per-workspace，channel worker、状态页和容量规划都会误读。

调整：旧 `workspaceCwd` 永远表示 primary；新增 `workspaces[]` 表示 registry 全量。status 中 session/SSE/ACP/auth 等 total 指标明确为进程级，需要展示隔离状态时增加 per-workspace 字段。

### 审计 14：channel pidfile schema

发现问题：serve-managed channel service pidfile 当前只有一个 `workerPid`。如果 `--channel a --channel b` 分别属于不同 workspace，supervisor 会有多个 worker，但 `qwen channel status` 只能展示一个 worker pid。

调整：pidfile additive 增加 workspace worker 列表；旧 `workerPid` 继续作为 primary/单 worker 兼容字段，`qwen channel stop` 仍要求停止 owning serve process。

### 审计 15：HTTP telemetry workspace attribute

发现问题：daemon telemetry middleware 当前在注册时根据单个 `boundWorkspace` 计算 `workspaceHash`。即使 service id 改成 daemon-scoped，如果 middleware 仍闭包捕获 primary hash，非 primary 请求的 spans/metrics 也会被归到 primary。

调整：route resolution 后写入 resolved workspace context，telemetry span/metric 从 request context 读取 workspace attribute；无法解析 workspace 的失败请求记录 unknown/requested，而不是套用 primary。

### 审计 16：persisted session 无 selector 读路径

发现问题：live session 可以通过 bridge/index 找 runtime，但 persisted-only session 不在 live index 中。`load/resume` 还能通过 body cwd 定位；`GET /session/:id/export` 这类无 body 的 route 当前直接读取 primary `SessionService`。

调整：非 primary persisted session 操作必须走 workspace-qualified route 或显式 cwd；legacy 无 selector GET route 保持 primary-only，不默认扫描所有 workspace storage。

### 审计 17：daemon-side env consumers

发现问题：把 `.env` 只变成 ACP child overlay 还不够。providers status、voice transcription、auth provider install/model resolution、preflight 等 daemon 父进程路径也可能通过 env 解析 credential。如果这些路径继续读全局 `process.env`，非 primary workspace 会拿到 primary env。

调整：每个 runtime 暴露 effective env，daemon-side workspace helpers 显式使用该 env；禁止在 async request 期间临时覆盖全局 `process.env`。

### 审计 18：Phase 2 session 闭环

发现问题：如果 Phase 2 只允许 `POST /session { cwd }` 创建非 primary session，而 `/session/:id/prompt`、events、cancel、permission 仍绑定 primary bridge，就会出现“能创建和列出，但无法对话”的断裂状态。

调整：session-scoped runtime dispatch 必须并入 Phase 2a，与 `POST /session { cwd }` 同批交付；Phase 1+2a 的验收条件包含非 primary session 能 prompt、订阅 events、cancel、处理 permission，并维护 model/mode 等 session-scoped state。

### 审计 19：runtime preheat

发现问题：boot 时对所有 runtime 调 `bridge.preheat()` 会并发 spawn N 个 ACP child，造成 CPU/RSS 冷启动突刺，并与 idle runtime lazy spawn 目标冲突；旧 `startup.preheat` 也只能表达一个 workspace。

调整：默认只 preheat primary。旧 `startup.preheat` 保留 primary 语义，status additive 增加 per-workspace preheat 状态；non-primary 记录 lazy/not_scheduled。

### 审计 20：parameterized legacy read-only routes

发现问题：文档同时说 legacy routes primary-only，又说 `GET /workspace/:id/sessions` 可以继续支持。该 route 自带 workspace 参数，不明确会导致 Web Shell/SDK 兼容行为分裂。

调整：已参数化的 read-only legacy routes 可接受 registered workspace；singular mutation routes 不放宽，非 primary mutations 使用 plural namespace。

### 审计 21：maxTotalSessions admission

发现问题：每个 bridge 只能 enforce per-workspace cap，进程级 `maxTotalSessions` 如果只写在 capabilities/status 中，没有执行点。跨 workspace 并发创建还可能双双通过总量检查。

调整：registry/serve 层提供 total session admission gate，fresh spawn 前原子占位，失败回滚，close/delete 释放；attach 不占位，拒绝语义为 503 + `Retry-After: 5`。

### 审计 22：process-level metrics aggregation

发现问题：daemon gauge callbacks、permission audit ring、child rss/cpu sampler 当前都隐含单 bridge/单 child。多 runtime 下继续闭包捕获 primary 会让 status 和 telemetry 低报或错报。

调整：gauge 通过 registry 聚合；permission audit entry 带 workspace 或由 status 聚合 per-runtime rings；child resource sampler 明确 total 与 per-workspace 视图。

### 审计 23：user-scope settings lock

发现问题：`withSettingsLock(workspace)` 按 workspace path 加锁，但 user-scope settings 写的是同一个 `~/.qwen/settings.json`。两个 runtime 同时写 user scope 会绕过单进程串行化。

调整：settings lock key 按目标 settings 文件路径，而不是 workspace path；workspace-scope 文件仍按 workspace 文件路径锁。

### 审计 24：rate limiter fairness

发现问题：v1 rate limiter 是进程级，一个 workspace 的高流量客户端可能耗尽全局配额，影响其他 workspace。

调整：把全局 rate limiter 作为已知限制写入容量章节；v1 不承诺 workspace 之间的公平配额，后续再评估 workspace-aware limiter。

### 审计 25：serve feature tags 与缓存归属

发现问题：`createServeFeatures()` 中的 `workspace_voice_transcription` 由 `loadSettings(boundWorkspace)` 推导并有模块级缓存。多 runtime 下，如果顶层 `features[]` 不定义归属，primary 和 non-primary 的 voice 配置会互相给出错误 pre-flight 结论；non-primary 的 settings 事件也可能误失效 primary feature cache。

调整：顶层 `features[]` 定义为 daemon/primary 语义。workspace-specific feature 判断走 workspace-qualified status / voice status，或后续 additive 镜像到 `workspaces[]`。feature cache invalidation 按 owning workspace 过滤，只有 primary settings/reload 影响顶层 cache。

### 审计 26：capabilities workspaces trusted 字段

发现问题：untrusted workspace 可以注册但 mutation route 返回 403；如果 `workspaces[]` 不暴露 trust，workspace picker 和 SDK 只能在用户点击后才发现写入口不可用。

调整：`workspaces[]` entry additive 增加 `trusted` 字段；read-only 能力仍可展示，mutation UI/SDK 可提前禁用或提示。

### 审计 27：WebSocket upgrade 分发

发现问题：`/workspaces/:workspace/acp` 和 `/workspaces/:workspace/voice/stream` 是 HTTP server 级 WebSocket upgrade path，不会自动进入 Express route。只加 REST/Express route 会漏掉真正的连接分发。

调整：upgrade listener 必须解析 path、做 workspace resolution 和既有 auth/host 校验，再把 socket 分发给目标 runtime 的 ACP dispatcher 或 voice handler；legacy `/acp`、`/voice/stream` 继续绑定 primary。

### 审计 28：Phase 2 半启用门闩

发现问题：Phase 2 吸收 session dispatch、admission、env overlay、telemetry/log、channel worker、preheat、pidfile 等子项后体量较大。若分 PR 落地，中间态可能启动一个能力不完整的多 workspace daemon。

调整：Phase 2a 全部子项完成前，多个 explicit workspace 直接 boot error。最后一个 PR 摘掉门闩，并以完整 Phase 2a 验收作为合入条件。

### 审计 29：ACP dispatcher session 创建路径

发现问题：`/session/:id/...` 的 registry index 如果只在 REST route 层调用 `noteSession`，会漏掉 ACP dispatcher 内部直接调用 `bridge.spawnOrAttach` 的 `session/new`、load、resume 路径。Web Shell 创建的 session 随后被 REST export、organization、telemetry 访问时只能 fallback 扫描，索引价值不足。

调整：推荐由 registry 通过 bridge session lifecycle callback 集中填充和清理 `sessionId -> workspaceKey`。若实现阶段暂时仍手工填充，也必须覆盖 REST 和 runtime-bound ACP dispatcher 的所有 session 创建路径。child crash 后 stale index 继续靠 bridge not found 惰性清理；total cap 仍以 live `sessionCount` + in-flight reservation 计算。

### 审计 30：公开文档更新

发现问题：多份公开文档仍承诺“一个 daemon 等于一个 workspace”，并把多 workspace 部署解释为多个 daemon。如果 Phase 2 摘门闩时不更新文档，用户文档、协议参考和实际行为会立即冲突。

调整：Phase 2 摘除 feature gate 的 PR 同批更新 `docs/users/qwen-serve.md`、`docs/developers/qwen-serve-protocol.md`、`docs/developers/examples/daemon-client-quickstart.md`、`docs/users/qwen-serve-deploy-local.md`、其他公开 daemon/channel 文档和 changelog，覆盖重复 `--workspace`、capabilities 新字段、limits、trusted、plural routes、workspace_mismatch / boundWorkspaces 语义和 multi-workspace deployment。

### 审计 31：plural route rate-limit tier

发现问题：`rate-limit.ts` 通过 method/path 解析 prompt、mutation、read 三档。新增 `/workspaces/:workspace/...` 如果没有显式映射，可能落入 fallback，导致同语义新旧路由档位不一致，尤其是未来 workspace-qualified prompt 类路径。

调整：rate-limit tier resolver 显式识别 plural namespace，解析 workspace 前缀后复用同语义 singular route 的 tier。测试覆盖 read/mutation/prompt 三类代表路径。

### 审计 32：maintainer feedback 后的首个里程碑收窄

发现问题：原 Phase 2 把 session 闭环、plural REST、channel workers、voice、ACP/Web Shell、pidfile、公开文档等放在同一个“静态多 workspace 启动”阶段。维护者反馈指出首个 ungated milestone 应该是 session closed loop，而不是“所有 workspace APIs 都多 workspace 化”，否则 review 面和交付风险都过大。

调整：把首个启用阶段收窄为 Phase 2a：static multi-workspace session closed loop + capabilities/status + `maxTotalSessions` admission + per-runtime env overlay。channel workers、workspace-qualified voice/ACP/Web Shell 和宽 REST 面后置；Phase 2a 对未支持 surface 保持 primary-only 或返回明确 unsupported / `workspace_mismatch`。

## 二次无方向审计：方案筛选

这轮审计不以证明推荐方案为目标，而是重新从架构边界、兼容性、隔离、失败路径、资源、测试和迁移成本几个方向筛掉不适合首版的路线。

### 审计维度

- 架构边界：是否需要改动 `AcpSessionBridge` 的 channel/default session/concurrency 内核。
- API 兼容：旧 SDK、旧 Web Shell、旧 `/workspace/...` route 是否保持 primary 行为。
- 隔离性：settings、MCP、permissions、memory、filesystem writes 是否按 workspace 隔离。
- 失败路径：child crash、stale session index、unknown cwd、workspace 删除是否局部化。
- 资源边界：多 workspace 是否导致 session、child、path lock、MCP registry 无限制扩张。
- 测试性：能否用小步单测证明行为，而不是一口气改完整 daemon surface。
- 迁移成本：是否能先交付一个可用闭环，再迁移文件、memory、MCP、ACP 等更宽 API。

### Round 1：架构拓扑

候选拓扑：

| 候选                               | 结论            | 主要原因                                                                                   |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| 外部多 daemon registry             | 保留为 fallback | 风险低、隔离好，但不满足单 daemon 多 workspace 的目标。                                    |
| 单 daemon，多 workspace runtime    | 首选            | 复用单 workspace bridge，不碰最复杂的 channel 生命周期；隔离边界清楚。                     |
| 一个 bridge 内部多 workspace state | 淘汰首版        | 需要把 `defaultEntry`、`channelInfo`、`aliveChannels`、spawn coalescing 全部变成多维状态。 |
| 一个 ACP child 多 cwd              | 淘汰首版        | sessionless workspace-level ext methods、runtime MCP、settings/status 容易混用。           |
| 只扩展 filesystem multi-root       | 淘汰            | 只能解决文件访问边界，不能表达 session/settings/MCP/memory 的 workspace 归属。             |

筛选结果：只保留“单 daemon，多 workspace runtime”作为产品主线；“外部多 daemon registry”只作为部署 fallback。

### Round 2：API 形态

候选 API：

| 候选                              | 结论         | 主要原因                                                                                                      |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| 继续扩展 `/workspace/:id/...`     | 不作为新主线 | 已有 `/workspace/memory`、`/workspace/settings` 等 legacy route，继续叠加容易造成 route order 和语义冲突。    |
| 所有 route 加 `?workspaceCwd=`    | 不推荐       | 对 mutation route 不够显式，也容易让 workspace 选择散落到每个 handler 的 query/body 分支里。                  |
| 新增 `/workspaces/:workspace/...` | 首选         | 与 legacy singular namespace 隔离，workspace-less 旧 route 绑定 primary，新 route 显式选择 workspace。        |
| 引入 opaque workspace id          | 后置         | 能减少 URL path 暴露和长度问题，但会增加 capabilities、SDK、debug、错误消息复杂度。首版直接沿用 encoded cwd。 |

筛选结果：新 API 使用 plural namespace；workspace-less legacy API 不改变，已参数化 read-only legacy route 只做 additive 兼容放宽；opaque id 等稳定后再评估。

### Round 3：隔离与安全

被筛掉的做法：

- unknown cwd 自动创建 runtime：扩大文件边界和资源占用，淘汰。
- 全局 `ClientMcpSenderRegistry` 被所有 workspace 共用：sessionless MCP 请求归属不清，淘汰。
- 每个 runtime 独立 path lock registry：重叠 root 或 symlink 情况下会削弱写串行保护，淘汰。
- implicit IDE secondary roots 自动升级成 full workspace：trust 和产品语义都不清楚，淘汰。

保留做法：

- workspace 只能从启动时 explicit 列表注册。
- explicit untrusted workspace 可以注册，但 mutating route 返回 403。
- 每个 workspace runtime 独立 settings、MCP、memory lane、workspace service。
- path lock registry 进程级共享。

### Round 4：生命周期与资源

最适合首版的组合：

- runtime 在启动时创建，ACP child 按现有 bridge 逻辑 lazy spawn。
- 一个 workspace child crash 只影响该 runtime。
- `maxSessions` 保持每 workspace 语义。
- 新增 `maxTotalSessions` 作为进程级上限，有限 `maxSessions` 时默认 `maxSessions * workspaceCount`，并由 registry admission gate 原子执行。
- shutdown 由 registry 聚合关闭所有 runtime，单个 close 失败不阻断其他 runtime 的 close。

暂不进入首版：

- dynamic add/remove workspace。
- runtime drain/remove。
- workspace hot reload 后自动重建 runtime。

原因是这些能力需要更多生命周期状态机，和首版 session/status 闭环没有强依赖。

### Round 5：SDK 与客户端迁移

最适合的 SDK 形态是“双层客户端”：

- `DaemonClient` 继续保留 workspace-less primary behavior。
- 新增 `WorkspaceDaemonClient`，由 `client.getWorkspaceClient(workspaceCwd)` 创建。
- workspace client 封装 `/workspaces/:workspace/...` 路径，避免每个调用点手写 encoded cwd。
- `DaemonCapabilities.workspaceCwd` 继续表示 primary，新增 `workspaces` 和 `features: ["multi_workspace"]`。

被筛掉的做法：

- 直接把所有 `DaemonClient` 方法改成必须传 workspace：破坏旧客户端。
- 只在 `createSession` 支持 cwd，其他 workspace route 仍无选择能力：只能创建非 primary session，无法管理对应 workspace 状态。

### Round 6：测试与落地顺序

最适合的实现顺序：

1. 单 runtime registry，无行为变化。
2. Phase 2a：静态 multi-workspace session closed loop、capabilities/status、total admission、env isolation。
3. Phase 2b：基础 workspace-qualified reads。
4. workspace-qualified REST routes。
5. workspace-qualified ACP/Web Shell。
6. channel workers / voice workspace 化。
7. 动态 workspace。

被筛掉的顺序：

- 先做 ACP/Web Shell workspace picker：依赖太多 route 和 runtime 选择能力。
- 先改 bridge 内核：验证面太大。
- 先做 dynamic workspace：安全和资源问题会盖过主线。

### 最终筛选

最适合首版实施的方案：

1. **S1：静态 multi-workspace session closed loop。** 一个 daemon 进程内注册多个 explicit workspace，每个 workspace 一个独立 runtime；`POST /session { cwd }` 可创建 non-primary session，所有 `/session/:id/...` route 按 session ownership 分发；workspace-less legacy API 走 primary。
2. **S2：workspace-qualified REST + SDK facade。** 在 S1 稳定后新增 `/workspaces/:workspace/...` 和 `WorkspaceDaemonClient`，优先迁移 sessions、file、memory、settings、MCP 这类 workspace-scoped API。
3. **S3：workspace-qualified ACP/Web Shell。** 等 REST 和 runtime 选择稳定后，再让 Web Shell 通过 `/workspaces/:workspace/acp` 连接指定 workspace。

最适合作为短期 fallback 的方案：

1. **F1：外部多 daemon registry。** 如果产品当前只需要 IDE/SDK 能同时看到多个 workspace，而不强求单端口/单 auth/token，可以先用外部 registry 编排多个 daemon。

不适合首版的方案：

1. **R1：bridge 内部多 workspace map。** 改动集中在高并发会话内核，不利于小步验证。
2. **R2：单 ACP child 多 workspace。** workspace-level 状态隔离证据不足。
3. **R3：filesystem multi-root 伪装成 multi-workspace。** 不能解决 session/settings/MCP/memory 归属。
4. **R4：dynamic workspace first。** 安全边界和资源边界过早扩大。
5. **R5：opaque workspace id first。** 能改善 URL，但不是首版闭环的必要复杂度。

## 最终建议

按选项 B 分阶段实现。最重要的设计原则是：多 workspace 是 daemon serve 层的编排能力，不是 ACP bridge 的内部多租户能力。

首个可交付闭环建议是 Phase 1 + Phase 2a：

- 一个 daemon 启动多个 explicit workspace。
- `/capabilities` 能列出 workspaces。
- `POST /session { cwd }` 能在非 primary workspace 创建 session，并且该 session 的 prompt、events、cancel、permission、model/mode 等 `/session/:id/...` 请求能命中正确 runtime。
- `maxTotalSessions` 在 fresh session 创建前执行 admission，attach 不计数。
- non-primary runtime 使用自己的 env overlay，daemon-side helpers 不读错 primary/global env。
- workspace-less legacy API 保持 primary 行为；已参数化的 read-only legacy session routes 可读取 registered workspace。
- channel workers、workspace-qualified ACP/Web Shell、workspace-qualified voice 和更宽 plural REST 面不进入 Phase 2a；未支持 surface 保持 primary-only 或返回明确 unsupported / `workspace_mismatch`。

这个闭环足以验证 session 对话、storage、status 和兼容性，同时把文件、memory、MCP、ACP Web Shell 的更宽 API 面留到后续阶段逐步迁移。
