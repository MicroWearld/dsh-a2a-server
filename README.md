# dsh-a2a-server

独立的 DeepSeek Harness A2A Server 插件。

将 DSH agent 暴露为 A2A（Agent2Agent）协议端点：

- AgentCard：`http://127.0.0.1:4123/.well-known/agent.json`
- JSON-RPC：`http://127.0.0.1:4123/a2a`
- SSE：`SendStreamingMessage`

## 特性

- A2A v1.0 JSON-RPC / SSE
- Task ↔ DSH Session 映射
- Bearer token 认证
- Task TTL 清理
- Prometheus `/metrics`
- Task 文件持久化（`persistTasks` + `persistenceRoot`）
- `input-required` approval 映射
- Role 归一化（`user` / `ROLE_USER` 都支持）
- Agent preset 配置（全局 `agentPreset` + 请求体 `metadata.agentPreset` 覆盖）

## 构建

需要本机有 DeepSeek Harness 源码 checkout，并设置：

```bash
export DSH_CHECKOUT=/path/to/deepseek-harness
bash scripts/build.sh
```

或直接：

```powershell
$env:DSH_CHECKOUT = "D:\workspace\dsh\deepseek-harness"
bash scripts/build.sh
```

## Windows 构建

```powershell
$env:DSH_CHECKOUT = "D:\workspace\dsh\deepseek-harness"
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

或：

```powershell
npm run build:ps1
```

## 下载自动构建产物

每次向 `main` 推送代码、更新 Pull Request，或手动运行 GitHub Actions 的
`Build` 工作流时，都会生成可安装的 npm `.tgz` 包。

### 从 GitHub 网页下载

1. 打开仓库的 [Actions → Build](https://github.com/MicroWearld/dsh-a2a-server/actions/workflows/build.yml)。
2. 进入最近一次状态为绿色的构建。
3. 在页面底部的 **Artifacts** 区域下载
   `dsh-a2a-server-<commit SHA>`。
4. 解压下载的 ZIP，即可获得 `dsh-a2a-server-<version>.tgz`。

> GitHub Actions 构建产物保留 14 天；长期分发请使用 GitHub Release。

## 安装

使用 DSH 官方插件装配命令：

```powershell
cd D:\workspace\dsh
dsh plugin --profile desktop add .\dsh-a2a-server\
```

安装完成后重启 DSH Desktop（或对应 profile 的运行时）使插件加载。

> 说明：`dsh plugin add` 会将该插件写入 profile 的 `dependencies` 与 `bundles`，并按官方装配流程加载 `cordis.patch.yml`。

## 配置示例

```yaml
- id: a2a-server
  name: 'dsh-a2a-server'
  config:
    path: /a2a
    agentCardPath: /.well-known/agent.json
    host: 127.0.0.1
    port: 4123
    cwd: /workspace
    provider: deepseek-official
    model: deepseek-v4-pro
    agentPreset: standard
    auth:
      type: bearer
      tokenEnv: A2A_TOKEN
    taskTtlMs: 3600000
    metricsPath: /metrics
    persistTasks: true
    persistenceRoot: ./.sessions
    agentCard:
      name: DeepSeek Harness A2A Agent
      description: A DeepSeek Harness agent exposed over A2A
```

## 请求级 preset

在 A2A `SendMessage` / `SendStreamingMessage` 请求的 `params.metadata` 中传入 `agentPreset`（或兼容别名 `preset`），即可覆盖全局配置：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "req-001",
      "role": "ROLE_USER",
      "parts": [{ "text": "你好" }]
    },
    "configuration": {
      "acceptedOutputModes": ["text/plain"]
    },
    "metadata": {
      "agentPreset": "coding"
    }
  }
}
```

优先级：请求 `metadata.agentPreset` / `metadata.preset` > 全局配置 `agentPreset`。

### 调用方如何发现 preset 设置方式

AgentCard 会在 `capabilities.extensions` 中声明 preset 选择扩展：

```json
{
  "uri": "https://dsh.local/a2a/preset-selection",
  "description": "To select an agent preset for a task, include \"agentPreset\" (or \"preset\") in SendMessage/SendStreamingMessage params.metadata.",
  "required": false,
  "params": {
    "metadataKey": "agentPreset",
    "aliases": ["preset"],
    "default": "standard",
    "presets": ["standard", "router-standard"]
  }
}
```

调用方读取 AgentCard 即可知道：

- 在 `params.metadata` 里传 `agentPreset`（或 `preset`）
- 可用 preset 列表在 `params.presets`
- 服务端默认 preset 在 `params.default`

## 说明

- 本插件不是 `@deepseek-ai` 官方包，使用无 scope 包名 `dsh-a2a-server`。
- 只依赖 DSH 官方 `@deepseek-ai/*` 包与 `@a2a-js/sdk`，不依赖其他第三方插件。
- 构建产物 `lib/index.js` 已自包含打包 `@a2a-js/sdk` 等运行时依赖。
