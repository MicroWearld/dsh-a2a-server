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
- Agent preset 配置（`agentPreset`）

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

## 安装

### 方式一：注入当前 DSH 运行时

```powershell
dev_inject_plugin --dir D:\workspace\dsh\dsh-a2a-server
```

### 方式二：作为 bundle 安装

```powershell
dev_install_package --dir D:\workspace\dsh\dsh-a2a-server
```

或通过 profile patch 引入 `cordis.patch.yml`。

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

## 说明

- 本插件不是 `@deepseek-ai` 官方包，使用无 scope 包名 `dsh-a2a-server`。
- 只依赖 DSH 官方 `@deepseek-ai/*` 包与 `@a2a-js/sdk`，不依赖其他第三方插件。
- 构建产物 `lib/index.js` 已自包含打包 `@a2a-js/sdk` 等运行时依赖。
