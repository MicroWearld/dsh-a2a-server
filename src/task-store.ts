/**
 * File-backed A2A TaskStore for `persistTasks`.
 *
 * The store persists the SDK Task objects that `DefaultRequestHandler` saves as
 * it processes agent events. It is intentionally simple: a single JSON file,
 * serialized writes, and no incremental journal.
 *
 * @module @deepseek-ai/dsh-a2a-server/task-store
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk'
import type {
  ServerCallContext,
  TaskStore,
} from '@a2a-js/sdk/server'

/**
 * Load tasks from a JSON file and persist every save to the same file.
 */
export class FileTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Load the initial task set from disk. Missing files start empty. */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error(`a2a-server: task store file is not an array: ${this.file}`)
      for (const item of parsed) {
        const task = item as Task
        if (typeof task?.id !== 'string') throw new Error(`a2a-server: invalid task record in ${this.file}`)
        this.tasks.set(task.id, task)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
  }

  async save(task: Task, _context: ServerCallContext): Promise<void> {
    this.tasks.set(task.id, structuredClone(task))
    await this.persist()
  }

  async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    const task = this.tasks.get(taskId)
    return task === undefined ? undefined : structuredClone(task)
  }

  async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    const all = [...this.tasks.values()]
    const filtered = all.filter(task => {
      if (params.contextId !== '' && task.contextId !== params.contextId) return false
      if (params.status !== 0 && task.status?.state !== params.status) return false
      return true
    })
    const pageSize = params.pageSize ?? 50
    const pageToken = Number(params.pageToken || 0)
    const page = filtered.slice(pageToken, pageToken + pageSize)
    return {
      tasks: page.map(task => structuredClone(task)),
      nextPageToken: pageToken + page.length < filtered.length ? String(pageToken + page.length) : '',
      pageSize,
      totalSize: filtered.length,
    }
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify([...this.tasks.values()], null, 2), 'utf8')
    })
    return this.writeChain
  }
}
