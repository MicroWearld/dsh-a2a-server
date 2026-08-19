/**
 * A2A server bridge: exposes DeepSeek Harness agents over the Agent2Agent
 * protocol. The plugin serves an AgentCard and a JSON-RPC 2.0 endpoint; each
 * A2A Task maps to one DSH Session/Agent.
 *
 * @module dsh-a2a-server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentCard, TaskState, formatSSEEvent } from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus, TaskStore } from '@a2a-js/sdk/server'
import type {
  AgentSkill,
  Artifact,
  Message,
  Part,
  TaskStatus,
} from '@a2a-js/sdk'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { FileTaskStore } from './task-store.js'

export const name = 'dsh-a2a-server'
export const inject = ['agents']

/** One configured A2A skill. */
export interface A2aSkillConfig {
  id: string
  name: string
  description: string
  tags?: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

/** Plugin config for the A2A server bridge. */
export interface A2aServerConfig {
  /** JSON-RPC endpoint path. */
  path?: string
  /** AgentCard discovery path. */
  agentCardPath?: string
  /** Standalone HTTP server bind host, used only when `webServer` is absent. */
  host?: string
  /** Standalone HTTP server port, used only when `webServer` is absent. */
  port?: number
  /** Working directory for created agents. */
  cwd?: string
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Agent preset id used to compose every A2A-created agent. */
  agentPreset?: string
  /** Optional bearer-token authentication for the JSON-RPC endpoint. */
  auth?: {
    /** Authentication scheme (only `bearer` is implemented). */
    type?: 'bearer'
    /** Literal bearer token. */
    token?: string
    /** Environment variable holding the bearer token. */
    tokenEnv?: string
  }
  /** Completed Task retention before automatic cleanup, in milliseconds. */
  taskTtlMs?: number
  /** Optional Prometheus-style metrics endpoint path, e.g. `/metrics`. */
  metricsPath?: string
  /** Admin control endpoint prefix, e.g. `/a2a/admin`. */
  adminPath?: string
  /** Persist A2A Task state to a JSON file under `persistenceRoot`. */
  persistTasks?: boolean
  /** Directory for the persisted Task file when `persistTasks` is true. */
  persistenceRoot?: string
  /** AgentCard metadata. */
  agentCard?: {
    name?: string
    description?: string
    url?: string
    version?: string
    capabilities?: { streaming?: boolean; pushNotifications?: boolean }
    skills?: A2aSkillConfig[]
  }
}

export const Config: Schema<A2aServerConfig> = Schema.object({
  path: Schema.string(),
  agentCardPath: Schema.string(),
  host: Schema.string(),
  port: Schema.natural().max(65535),
  cwd: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  agentPreset: Schema.string(),
  auth: Schema.object({
    type: Schema.union(['bearer'] as const).default('bearer'),
    token: Schema.string(),
    tokenEnv: Schema.string(),
  }),
  taskTtlMs: Schema.natural().min(1),
  metricsPath: Schema.string(),
  adminPath: Schema.string().default('/a2a/admin'),
  persistTasks: Schema.boolean().default(false),
  persistenceRoot: Schema.string(),
  agentCard: Schema.object({
    name: Schema.string(),
    description: Schema.string(),
    url: Schema.string(),
    version: Schema.string(),
    capabilities: Schema.object({
      streaming: Schema.boolean(),
      pushNotifications: Schema.boolean(),
    }),
    skills: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string().required(),
      description: Schema.string().required(),
      tags: Schema.array(Schema.string()),
      examples: Schema.array(Schema.string()),
      inputModes: Schema.array(Schema.string()),
      outputModes: Schema.array(Schema.string()),
    })),
  }),
})

/** Per-task protocol state. */
/** One machine approval decision this bridge can resolve from client input. */
type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'

/** Minimal view of the approval/request payload this bridge owns. */
interface ApprovalRequestLike {
  agent: Agent
  callId?: string
}

interface TaskRecord {
  taskId: string
  contextId: string
  agent: Agent
  dispose: () => Promise<void>
  eventBus?: ExecutionEventBus
  terminalPublished: boolean
  createdAt: number
  pendingApproval?: {
    request: ApprovalRequestLike
    resolve: (decision: ApprovalDecision) => void
  }
}

/** Minimal structural view of `@deepseek-ai/dsh-host-webserver` route registration. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Mount the A2A server bridge.
 * @param ctx - Cordis context carrying the agent factory.
 * @param config - A2A server configuration.
 */
export async function apply(ctx: Context, config: A2aServerConfig): Promise<void> {
  const logger = ctx.logger
  const records = new Map<string, TaskRecord>()
  const path = config.path ?? '/a2a'
  const agentCardPath = config.agentCardPath ?? '/.well-known/agent.json'
  const adminPath = config.adminPath ?? '/a2a/admin'
  const cwd = config.cwd ?? process.cwd()
  const authToken = resolveAuthToken(config)
  const metrics = createMetrics()
  let enabled = true

  const ownedRecord = (agent: Agent): TaskRecord | undefined => {
    const record = records.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  let taskStore: TaskStore = new InMemoryTaskStore()
  if (config.persistTasks === true) {
    if (ctx.get('sessionPersistence') === undefined) {
      throw new Error('a2a-server: persistTasks requires sessionPersistence to be mounted')
    }
    const fileTaskStore = new FileTaskStore(join(config.persistenceRoot ?? cwd, 'a2a-tasks.json'))
    await fileTaskStore.init()
    taskStore = fileTaskStore
  }

  const agentCard = makeAgentCard(config, path, await listPresetIds(ctx))
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    makeExecutor(ctx, records, config, cwd, metrics),
  )
  const jsonRpc = new JsonRpcTransportHandler(requestHandler)

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/'
    metrics.requests++
    if (req.method === 'GET' && url === agentCardPath) {
      sendJson(res, AgentCard.toJSON(makeAgentCard(config, path, await listPresetIds(ctx))))
      return
    }
    if (config.metricsPath !== undefined && req.method === 'GET' && url === config.metricsPath) {
      sendText(res, renderMetrics(metrics, records.size))
      return
    }
    if (url === `${adminPath}/status` || url === `${adminPath}/enable` || url === `${adminPath}/disable`) {
      if (authToken !== undefined && req.headers.authorization !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (req.method === 'GET' && url === `${adminPath}/status`) {
        sendJson(res, { enabled, activeTasks: records.size, ...metrics })
        return
      }
      if (req.method === 'POST' && (url === `${adminPath}/enable` || url === `${adminPath}/disable`)) {
        enabled = url.endsWith('/enable')
        sendJson(res, { enabled })
        return
      }
    }
    if (req.method === 'POST' && url === path) {
      if (authToken !== undefined && req.headers.authorization !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!enabled) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'a2a is disabled' }))
        return
      }
      const body = await readBody(req, 1024 * 1024)
      const context = new ServerCallContext({
        requestedVersion: (req.headers['a2a-version'] as string | undefined) ?? '1.0',
      })
      let requestBody: string | Record<string, unknown> = body
      try {
        requestBody = normalizeA2ARole(JSON.parse(body) as unknown) as Record<string, unknown>
      } catch {
        // Leave the original string to the SDK so malformed JSON still gets the
        // protocol's own JSON-RPC parse error.
      }
      const result = await jsonRpc.handle(requestBody, context)
      if (isAsyncIterable(result)) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        try {
          for await (const event of result) {
            res.write(formatSSEEvent(event))
          }
        } finally {
          res.end()
        }
      } else {
        sendJson(res, result)
      }
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer !== undefined) {
    const disposers = [
      webServer.register({ kind: 'exact', path: agentCardPath, handler: handleHttp }),
      webServer.register({ kind: 'exact', path, handler: handleHttp }),
      ...config.metricsPath === undefined ? [] : [webServer.register({ kind: 'exact', path: config.metricsPath, handler: handleHttp })],
      webServer.register({ kind: 'exact', path: `${adminPath}/status`, handler: handleHttp }),
      webServer.register({ kind: 'exact', path: `${adminPath}/enable`, handler: handleHttp }),
      webServer.register({ kind: 'exact', path: `${adminPath}/disable`, handler: handleHttp }),
    ]
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'a2a-server.routes')
  } else {
    const server = createServer(handleHttp)
    server.listen(config.port ?? 4123, config.host ?? '127.0.0.1')
    ctx.effect(() => () => {
      server.close()
      server.closeAllConnections?.()
    }, 'a2a-server.http')
  }

  // Stream committed assistant messages and terminal status to the owning A2A
  // task's event bus. This gives `message/sendStreaming` real committed-message
  // events instead of only a final snapshot.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = records.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    const eventBus = record.eventBus
    if (eventBus === undefined) return
    if (event.type === 'assistant/message') {
      const parts = contentBlocksToParts(event.data.message.content)
      if (parts.length > 0) {
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId: record.taskId,
          contextId: record.contextId,
          artifact: makeArtifact(record.taskId, parts),
          append: false,
          lastChunk: true,
          metadata: undefined,
        }))
      }
    } else if (event.type === 'turn/end' && !record.terminalPublished) {
      record.terminalPublished = true
      const failed = event.data.reason.kind === 'error'
      const status: TaskStatus = failed
        ? { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: new Date().toISOString() }
        : { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() }
      if (failed) metrics.failedTasks++
      else metrics.completedTasks++
      eventBus.publish(AgentEvent.statusUpdate({
        taskId: record.taskId,
        contextId: record.contextId,
        status,
        metadata: undefined,
      }))
    }
  })

  // Human-in-the-loop: when a bridge-owned agent requests approval, publish
  // INPUT_REQUIRED and wait for the A2A client to send a follow-up message on
  // the same Task. The follow-up text resolves the pending approval.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return new Promise<ApprovalDecision>((resolve) => {
      record.pendingApproval = { request, resolve }
      record.eventBus?.publish(AgentEvent.statusUpdate({
        taskId: record.taskId,
        contextId: record.contextId,
        status: status(TaskState.TASK_STATE_INPUT_REQUIRED),
        metadata: undefined,
      }))
    })
  })

  let ttlTimer: NodeJS.Timeout | undefined
  if (config.taskTtlMs !== undefined) {
    const ttlMs = config.taskTtlMs
    ttlTimer = setInterval(() => {
      void cleanupExpired(records, ttlMs, logger)
    }, Math.min(ttlMs, 60_000))
  }

  ctx.effect(() => () => {
    if (ttlTimer !== undefined) clearInterval(ttlTimer)
    return quiesce(records, logger)
  }, 'a2a-server.tasks')
}

/**
 * Build the AgentCard served at `agentCardPath`.
 * @param config - plugin configuration.
 * @param path - JSON-RPC endpoint path.
 * @param presetIds - available agent preset ids to advertise.
 * @returns a fully populated A2A AgentCard.
 */
function makeAgentCard(config: A2aServerConfig, path: string, presetIds: string[] = []): AgentCard {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 4123
  const skills: AgentSkill[] = (config.agentCard?.skills ?? []).map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    examples: skill.examples ?? [],
    inputModes: skill.inputModes ?? ['text/plain'],
    outputModes: skill.outputModes ?? ['text/plain'],
    securityRequirements: [],
  }))
  return {
    name: config.agentCard?.name ?? 'DeepSeek Harness Agent',
    description: config.agentCard?.description ?? 'A DeepSeek Harness agent exposed over A2A',
    supportedInterfaces: [{
      url: config.agentCard?.url ?? `http://${host}:${port}${path}`,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: '1.0',
    }],
    provider: undefined,
    version: config.agentCard?.version ?? '0.1.0',
    documentationUrl: undefined,
    capabilities: {
      streaming: config.agentCard?.capabilities?.streaming ?? true,
      pushNotifications: config.agentCard?.capabilities?.pushNotifications ?? false,
      extensions: [{
        uri: 'https://dsh.local/a2a/preset-selection',
        description: 'To select an agent preset for a task, include "agentPreset" (or "preset") in SendMessage/SendStreamingMessage params.metadata.',
        required: false,
        params: {
          metadataKey: 'agentPreset',
          aliases: ['preset'],
          default: config.agentPreset ?? null,
          presets: presetIds,
        },
      }],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    signatures: [],
    iconUrl: undefined,
  }
}

/**
 * Create the A2A AgentExecutor that maps Tasks to DSH agents.
 * @param ctx - Cordis context.
 * @param records - per-task bridge records.
 * @param config - plugin configuration.
 * @param cwd - working directory for new agents.
 * @returns an A2A SDK AgentExecutor.
 */
function makeExecutor(
  ctx: Context,
  records: Map<string, TaskRecord>,
  config: A2aServerConfig,
  cwd: string,
  metrics: Metrics,
): AgentExecutor {
  const agents = ctx.agents

  return {
    async execute(requestContext, eventBus) {
      const taskId = requestContext.taskId
      const contextId = requestContext.contextId
      const presetId = resolvePreset(requestContext.request.metadata, config.agentPreset)
      let record = records.get(taskId)
      if (record === undefined) {
        if (!isAbsolute(cwd)) throw new Error(`cwd must be an absolute path: ${cwd}`)
        const sessionId = SessionId(taskId)
        const handle = await agents.create({
          sessionId,
          meta: {
            cwd,
            ...(presetId !== undefined ? { agentPreset: presetId } : {}),
          },
          agentOptions: agentOptions(config),
          ...(presetId !== undefined ? {
            setup: async (agentCtx: Context) => {
              const presets = ctx.get('agentPresets') as
                { mount(agentCtx: Context, id?: string): Promise<unknown> } | undefined
              if (presets === undefined) {
                throw new Error(`a2a-server: agentPreset "${presetId}" configured but agentPresets service is unavailable`)
              }
              await presets.mount(agentCtx, presetId)
            },
          } : {}),
        })
        record = {
          taskId,
          contextId,
          agent: handle.agent,
          dispose: () => handle.dispose(),
          eventBus,
          terminalPublished: false,
          createdAt: Date.now(),
        }
        records.set(taskId, record)
        metrics.totalTasks++
      } else {
        record.contextId = contextId
        record.eventBus = eventBus
      }

      if (record.pendingApproval !== undefined) {
        const pending = record.pendingApproval
        delete record.pendingApproval
        pending.resolve(parseApprovalDecision(requestContext.userMessage))
        await record.agent.whenIdle()
        if (!record.terminalPublished) {
          record.terminalPublished = true
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_COMPLETED),
            metadata: undefined,
          }))
        }
        return
      }

      eventBus.publish(AgentEvent.task({
        id: taskId,
        contextId,
        status: status(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: undefined,
      }))
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_WORKING),
        metadata: undefined,
      }))

      const content = messageToContentBlocks(requestContext.userMessage)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      record.agent.followup(message)

      await record.agent.whenIdle()
      if (!record.terminalPublished) {
        record.terminalPublished = true
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_COMPLETED),
          metadata: undefined,
        }))
      }
    },
    async cancelTask(taskId, eventBus) {
      const record = records.get(taskId)
      if (record === undefined) return
      if (record.pendingApproval !== undefined) {
        const pending = record.pendingApproval
        delete record.pendingApproval
        pending.resolve('cancelled')
      }
      record.agent.cancel({ kind: 'user' })
      await record.agent.whenIdle()
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId: record.contextId,
        status: status(TaskState.TASK_STATE_CANCELED),
        metadata: undefined,
      }))
      metrics.canceledTasks++
    },
  }
}

/**
 * Dispose every bridge-owned agent and clear the task registry.
 * @param records - per-task bridge records.
 * @param logger - Cordis logger.
 */
async function quiesce(records: Map<string, TaskRecord>, logger: Context['logger']): Promise<void> {
  const tasks = [...records.values()]
  records.clear()
  const results = await Promise.allSettled(tasks.map(async (record) => {
    await record.agent.whenIdle()
    await record.dispose()
  }))
  for (const result of results) {
    if (result.status === 'rejected') logger.warn(`a2a-server: task teardown failed: ${String(result.reason)}`)
  }
}

/** Build a timestamped A2A TaskStatus. */
function status(state: TaskState): TaskStatus {
  return { state, message: undefined, timestamp: new Date().toISOString() }
}

/** Build one A2A artifact from text parts. */
function makeArtifact(taskId: string, parts: Part[]): Artifact {
  return {
    artifactId: `artifact-${taskId}`,
    name: 'assistant',
    description: '',
    parts,
    metadata: undefined,
    extensions: [],
  }
}

/** Convert DSH content blocks to A2A text parts. */
function contentBlocksToParts(blocks: ContentBlock[]): Part[] {
  const parts: Part[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push({
        content: { $case: 'text', value: block.text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      })
    }
  }
  return parts
}

/** Convert an A2A user Message to DSH content blocks. */
function messageToContentBlocks(message: Message): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of message.parts) {
    const value = part.content
    if (value === undefined) continue
    if (value.$case === 'text') {
      blocks.push({ type: 'text', text: value.value })
    } else if (value.$case === 'data') {
      blocks.push({ type: 'text', text: JSON.stringify(value.value) })
    } else if (value.$case === 'url') {
      blocks.push({ type: 'text', text: value.value })
    } else if (value.$case === 'raw') {
      blocks.push({ type: 'text', text: `[raw file ${part.filename || 'unnamed'}]` })
    }
  }
  return blocks
}

/**
 * Normalize A2A JSON-RPC role fields to the SDK's protobuf enum names.
 *
 * The A2A spec examples use lowercase `"user"` / `"agent"`, while the official
 * SDK's JSON parser expects `"ROLE_USER"` / `"ROLE_AGENT"`. This recursively
 * rewrites `role` fields so both wire styles are accepted.
 * @param value - parsed JSON-RPC request value.
 * @returns the same structure with normalized role strings.
 */
function normalizeA2ARole(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeA2ARole)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      result[key] = key === 'role' && typeof child === 'string'
        ? normalizeRoleValue(child)
        : normalizeA2ARole(child)
    }
    return result
  }
  return value
}

/** Map a lowercase A2A role to the SDK enum name; unknown values pass through. */
function normalizeRoleValue(role: string): string {
  switch (role) {
    case 'user': return 'ROLE_USER'
    case 'agent': return 'ROLE_AGENT'
    case 'unspecified': return 'ROLE_UNSPECIFIED'
    default: return role
  }
}

/** Simple Prometheus-style counters for the A2A server. */
interface Metrics {
  requests: number
  totalTasks: number
  completedTasks: number
  failedTasks: number
  canceledTasks: number
}

/** Create a zero-initialized metrics record. */
function createMetrics(): Metrics {
  return { requests: 0, totalTasks: 0, completedTasks: 0, failedTasks: 0, canceledTasks: 0 }
}

/**
 * List available agent preset ids for AgentCard discovery.
 * @param ctx - Cordis context.
 * @returns preset ids, or an empty array when the service is unavailable or cannot be read.
 */
async function listPresetIds(ctx: Context): Promise<string[]> {
  const agentPresets = ctx.get('agentPresets') as
    { list(): Promise<Array<{ id: string }>> } | undefined
  if (agentPresets === undefined) return []
  try {
    return (await agentPresets.list()).map(preset => preset.id)
  } catch {
    // Discovery is best-effort: an unreadable roster should not break AgentCard.
    return []
  }
}

/**
 * Resolve the agent preset id for one request: per-request metadata wins,
 * falling back to the global config.
 * @param metadata - the A2A SendMessage metadata map.
 * @param fallback - the configured global agentPreset.
 * @returns the preset id, or undefined when neither source provides one.
 */
function resolvePreset(
  metadata: Record<string, unknown> | undefined,
  fallback: string | undefined,
): string | undefined {
  const requested = metadata?.agentPreset ?? metadata?.preset
  if (typeof requested === 'string' && requested.length > 0) return requested
  return fallback
}

/** Resolve the configured bearer token from a literal or environment variable. */
function resolveAuthToken(config: A2aServerConfig): string | undefined {
  const auth = config.auth
  if (auth === undefined || (auth.token === undefined && auth.tokenEnv === undefined)) return undefined
  const token = auth.tokenEnv !== undefined ? process.env[auth.tokenEnv] : auth.token
  if (token === undefined || token === '') {
    throw new Error('a2a-server: auth is configured but no bearer token is available')
  }
  return token
}

/** Dispose terminal Tasks older than `ttlMs` and remove them from the registry. */
async function cleanupExpired(
  records: Map<string, TaskRecord>,
  ttlMs: number,
  logger: Context['logger'],
): Promise<void> {
  const now = Date.now()
  const expired: TaskRecord[] = []
  for (const [id, record] of records) {
    if (record.terminalPublished && now - record.createdAt >= ttlMs) {
      records.delete(id)
      expired.push(record)
    }
  }
  const results = await Promise.allSettled(expired.map(record => record.dispose()))
  for (const result of results) {
    if (result.status === 'rejected') logger.warn(`a2a-server: TTL task teardown failed: ${String(result.reason)}`)
  }
}

/** Render the metrics record as Prometheus text format. */
function renderMetrics(metrics: Metrics, activeTasks: number): string {
  return [
    '# HELP dsh_a2a_requests_total Total HTTP requests handled by the A2A server.',
    '# TYPE dsh_a2a_requests_total counter',
    `dsh_a2a_requests_total ${metrics.requests}`,
    '# HELP dsh_a2a_active_tasks Current number of live A2A tasks.',
    '# TYPE dsh_a2a_active_tasks gauge',
    `dsh_a2a_active_tasks ${activeTasks}`,
    '# HELP dsh_a2a_tasks_total Total A2A tasks created.',
    '# TYPE dsh_a2a_tasks_total counter',
    `dsh_a2a_tasks_total ${metrics.totalTasks}`,
    '# HELP dsh_a2a_completed_tasks_total Completed A2A tasks.',
    '# TYPE dsh_a2a_completed_tasks_total counter',
    `dsh_a2a_completed_tasks_total ${metrics.completedTasks}`,
    '# HELP dsh_a2a_failed_tasks_total Failed A2A tasks.',
    '# TYPE dsh_a2a_failed_tasks_total counter',
    `dsh_a2a_failed_tasks_total ${metrics.failedTasks}`,
    '# HELP dsh_a2a_canceled_tasks_total Canceled A2A tasks.',
    '# TYPE dsh_a2a_canceled_tasks_total counter',
    `dsh_a2a_canceled_tasks_total ${metrics.canceledTasks}`,
  ].join('\n')
}

/** Send a plain-text response. */
function sendText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** Parse an A2A follow-up message into an approval decision. */
function parseApprovalDecision(message: Message): ApprovalDecision {
  const text = message.parts
    .flatMap(part => part.content?.$case === 'text' ? [part.content.value] : [])
    .join(' ')
    .toLowerCase()
  if (text.includes('allow') || text.includes('approve') || text.includes('yes')) return 'allowed-once'
  if (text.includes('reject') || text.includes('deny') || text.includes('no')) return 'rejected'
  return 'rejected'
}

/** Read a bounded JSON request body. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Narrowing helper for the SDK's JSON-RPC streaming return. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/** Build per-agent options from config without assigning absent fields. */
function agentOptions(config: A2aServerConfig): AgentOptions {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}
