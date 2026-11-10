/**
 * Host half of `dsh-session-scrub`.
 *
 * Scrubbing one session removes every local trace: the log directory, its
 * subagent descendants, scheduled tasks that reference it, its workspace
 * account entry, pin/archive entries, the projection cache document, and
 * per-session spill directories. The HTTP reply is sent as soon as those are
 * gone, so the browser row disappears immediately; the expensive attachment
 * sweep runs afterwards in the background and reports progress to the dialog.
 *
 * @module dsh-session-scrub
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HOUR,
  findOrphans,
  homeOf,
  isSessionLogPath,
  parseConfig,
  pickAttachmentDigests,
  warningBag,
} from './logic.js'

/** Loader label. */
export const name = 'session-scrub'

/** Services the Host half needs; schedule and the live stores are optional. */
export const inject = ['connection', 'webServer', 'sessionPersistence', 'sessionQuery', 'workspaceRegistry']

/** Authenticated scrub route the browser posts to (the connection channel is `/api`). */
const ROUTE = '/api/dsh-session-scrub'

/** Authenticated progress route the dialog polls while the sweep runs. */
const STATUS_ROUTE = '/api/dsh-session-scrub-status'

/** Read-only diagnostic route, mounted only when `diagnostics` is enabled. */
const PROBE = '/dsh-session-scrub-probe'

/** Reported by the diagnostic route so a stale Host process is obvious. */
const VERSION = '1.0.0'

/** A refusal the browser shows with its own localized wording. */
class Refusal extends Error {
  /**
   * @param code - stable failure code for the browser.
   * @param message - English fallback message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'SessionScrubRefusal'
    this.code = code
  }
}

/** Progress of the last background attachment sweep. */
const sweepStatus = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  released: 0,
  kept: 0,
  failed: 0,
  cacheCleared: false,
  error: '',
}

/** JSON Fetch response with no caching. */
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Every session snapshot, in no promised order. */
function snapshotsOf(ctx) {
  return ctx.sessionPersistence.list()
}

/** Read the raw workspace document (authoritative membership, not the filtered projection). */
function readWorkspaceState(home) {
  const file = join(home, 'storages', 'workspace.json')
  const members = new Set()
  if (!existsSync(file)) return { members, ok: false }
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { members, ok: false }
  }
  if (doc === null || typeof doc !== 'object' || doc.tables === null || typeof doc.tables !== 'object') {
    return { members, ok: false }
  }
  for (const record of Object.values(doc.tables.workspaces ?? {})) {
    for (const id of record?.sessionIds ?? []) members.add(id)
  }
  // An unreadable registry must never look like "nobody owns anything": the
  // orphan sweep is skipped entirely unless this read succeeded.
  return { members, ok: true }
}

/** Complete raw events of one Session, serialized for reference scanning. */
async function sessionText(ctx, id) {
  const query = ctx.sessionQuery
  if (typeof query.readSession === 'function') {
    const snapshot = await query.readSession(id)
    if (Array.isArray(snapshot?.events)) return JSON.stringify(snapshot.events)
  }
  if (typeof query.listEvents === 'function') return JSON.stringify(await query.listEvents(id))
  throw new Error('this Harness exposes no readable session interface')
}

/** Run one read with a small retry ladder. */
async function withRetry(operation) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, [200, 1000][attempt] ?? 1000))
    }
  }
  throw lastError
}

/** Clear immutable/read-only attributes so Windows allows a removal. */
function makeWritable(path) {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return
  }
  if (stats.isDirectory()) {
    let entries = []
    try {
      entries = readdirSync(path)
    } catch {
      entries = []
    }
    for (const entry of entries) makeWritable(join(path, entry))
    try {
      chmodSync(path, 0o777)
    } catch {
      /* best effort */
    }
    return
  }
  try {
    chmodSync(path, 0o666)
  } catch {
    /* best effort */
  }
}

/**
 * Remove one path tree. Attachment objects are published read-only, so a plain
 * removal can fail with EPERM; attributes are cleared and the removal retried.
 * @param path - absolute path.
 */
function removePath(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 2 })
    return
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
  }
  makeWritable(path)
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

/** Total byte size of a file or directory tree; 0 when unreadable. */
function sizeOf(path) {
  let stats
  try {
    stats = statSync(path)
  } catch {
    return 0
  }
  if (stats.isFile()) return stats.size
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) total += sizeOf(join(path, entry.name))
  return total
}

/** Every attachment file under one object area. */
function objectFiles(home, area) {
  const root = join(home, 'attachments', 'v1', area)
  const files = []
  let buckets
  try {
    buckets = readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    let entries
    try {
      entries = readdirSync(join(root, bucket.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      files.push({ path: join(root, bucket.name, entry.name), digest: entry.name })
    }
  }
  return files
}

/** Attachment digests still cited by any surviving session. */
async function referencedDigests(ctx, snapshots) {
  const referenced = new Set()
  for (const snapshot of snapshots) {
    const id = snapshot.header.id
    const text = await withRetry(() => sessionText(ctx, id))
    for (const digest of pickAttachmentDigests(text)) referenced.add(digest)
  }
  return referenced
}

/**
 * Remove one attachment object, retrying the transient sharing violations a
 * running Host produces while it still serves images from those files.
 * @param path - absolute object path.
 */
async function removeObjectWithRetry(path) {
  const delays = [200, 800, 2000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      removePath(path)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (attempt >= delays.length || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** Per-session spill directories across every `dsh-spill-*` root in the OS temp dir. */
function spillDirsOf(id) {
  const hashed = createHash('sha256').update(id).digest('hex').slice(0, 12)
  const dirs = []
  let roots
  try {
    roots = readdirSync(tmpdir(), { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const entry of roots) {
    if (!entry.isDirectory() || !/^dsh-spill-[A-Za-z0-9]{6}$/.test(entry.name)) continue
    const candidate = join(tmpdir(), entry.name, `session-${hashed}`)
    if (existsSync(candidate)) dirs.push(candidate)
  }
  return dirs
}

/**
 * Remove artifacts whose session no longer exists: projection-cache documents
 * and per-session spill directories. Projection cache writes behind a timer, so
 * a deleted session's document can reappear; the sweep runs twice.
 * @param ctx - Host context.
 * @param home - harness home.
 */
async function cleanOrphanArtifacts(ctx, home) {
  let removedCache = 0
  let removedSpill = 0
  let liveIds
  try {
    liveIds = new Set((await snapshotsOf(ctx)).map((snapshot) => snapshot.header.id))
  } catch {
    return
  }
  const projDir = join(home, 'storages', 'session_projcache', 'sessions')
  try {
    for (const fileName of readdirSync(projDir)) {
      if (!fileName.endsWith('.json')) continue
      const id = fileName.slice(0, -'.json'.length)
      if (liveIds.has(id)) continue
      try {
        removePath(join(projDir, fileName))
        removedCache += 1
      } catch {
        /* next run */
      }
    }
  } catch {
    /* no cache directory */
  }
  const hashed = new Set([...liveIds].map((id) => createHash('sha256').update(id).digest('hex').slice(0, 12)))
  let roots = []
  try {
    roots = readdirSync(tmpdir(), { withFileTypes: true })
  } catch {
    roots = []
  }
  for (const root of roots) {
    if (!root.isDirectory() || !/^dsh-spill-[A-Za-z0-9]{6}$/.test(root.name)) continue
    const rootPath = join(tmpdir(), root.name)
    let subs = []
    try {
      subs = readdirSync(rootPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      const match = /^session-([0-9a-f]{12})$/.exec(sub.name)
      if (match === null || hashed.has(match[1])) continue
      try {
        removePath(join(rootPath, sub.name))
        removedSpill += 1
      } catch {
        /* next run */
      }
    }
  }
  if (removedCache > 0 || removedSpill > 0) {
    ctx.logger.info(
      `session-scrub: orphan artifacts removed (projcache ${String(removedCache)}, spill ${String(removedSpill)})`,
    )
  }
}

/**
 * Background attachment sweep: delete objects no surviving session cites and
 * that are older than the draft window, then clear the derived image cache.
 * Failures are counted, never thrown — the session is already gone.
 * @param ctx - Host context.
 * @param home - harness home.
 * @param config - resolved plugin config.
 */
async function sweepAttachments(ctx, home, config) {
  const startedAt = Date.now()
  const budgetMs = config.sweepBudgetSeconds * 1000
  const graceMs = config.draftGraceMinutes * 60 * 1000
  Object.assign(sweepStatus, {
    running: true,
    startedAt,
    finishedAt: 0,
    released: 0,
    kept: 0,
    failed: 0,
    cacheCleared: false,
    error: '',
  })
  try {
    // Every session that still has a log counts as a reference holder —
    // including sessions that are open right now.
    const snapshots = await snapshotsOf(ctx)
    const referenced = await referencedDigests(ctx, snapshots)
    const cutoff = Date.now() - graceMs
    let released = 0
    let kept = 0
    let failed = 0
    for (const area of ['objects', 'file-objects']) {
      for (const file of objectFiles(home, area)) {
        if (Date.now() - startedAt > budgetMs) {
          ctx.logger.warn('session-scrub: attachment sweep hit its time budget; remaining objects wait for the next run')
          break
        }
        if (referenced.has(file.digest)) {
          kept += 1
          sweepStatus.kept = kept
          continue
        }
        let stats
        try {
          stats = statSync(file.path)
        } catch {
          continue
        }
        if (stats.mtimeMs > cutoff) {
          kept += 1
          sweepStatus.kept = kept
          continue
        }
        try {
          await removeObjectWithRetry(file.path)
          released += 1
          sweepStatus.released = released
        } catch {
          failed += 1
          sweepStatus.failed = failed
        }
      }
    }
    let cacheCleared = false
    if (released > 0) {
      const requestImages = join(home, 'cache', 'attachments', 'request-images')
      if (existsSync(requestImages)) {
        try {
          removePath(requestImages)
          cacheCleared = true
        } catch {
          ctx.logger.warn('session-scrub: image cache could not be cleared')
        }
      }
    }
    sweepStatus.cacheCleared = cacheCleared
    ctx.logger.info(
      `session-scrub: attachment sweep released ${String(released)}, kept ${String(kept)}, failed ${String(failed)}, cacheCleared=${String(cacheCleared)}`,
    )
  } catch (error) {
    sweepStatus.error = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`session-scrub: attachment sweep failed: ${sweepStatus.error}`)
  } finally {
    sweepStatus.finishedAt = Date.now()
    sweepStatus.running = false
  }
}

/**
 * Scrub one session set.
 * @param ctx - Host context.
 * @param request - `{ sessionId, currentSessionId }`.
 * @param config - resolved plugin config.
 * @returns the payload the browser renders.
 */
async function scrubSession(ctx, request, config) {
  const snapshots = await snapshotsOf(ctx)
  const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
  const requested = typeof request.sessionId === 'string' ? request.sessionId : ''
  if (requested === '') throw new Refusal('bad-request', 'no session id was supplied')
  if (byId.get(requested) === undefined) throw new Refusal('session-missing', 'the session no longer exists')
  // Only genuinely running work is refused: a session merely loaded into this
  // process (opened earlier, now idle) must stay deletable.
  const agent = ctx.get('agents')?.get?.(requested)
  if (agent !== undefined && agent.status === 'running') throw new Refusal('session-running', 'the session is running')
  if (request.currentSessionId === requested) throw new Refusal('session-open', 'the session is open in the conversation view')

  const withPath = snapshots.find((snapshot) => snapshot.location?.path !== undefined)
  const home = withPath !== undefined ? homeOf(withPath.location.path) : process.env.DSH_HOME
  if (home === undefined) throw new Refusal('home-unknown', 'cannot resolve the harness home directory')

  const state = readWorkspaceState(home)
  const live = new Set((ctx.get('sessions')?.list() ?? []).map((session) => session.id))

  // Seeds: the requested session plus — when enabled — every session nobody owns.
  const seeds = new Map([[requested, 'session']])
  const orphans =
    config.orphanSweep && state.ok
      ? findOrphans(snapshots, state.members, live, new Set(seeds.keys()), config.orphanMinimumAgeHours * HOUR)
      : []
  for (const orphan of orphans) seeds.set(orphan.id, orphan.kind)

  // Cascade: every subagent descendant of a scrubbed session goes with it.
  // Fork children carry no parentSession, so they are never swept by this.
  const skippedLive = []
  const deletion = new Set(seeds.keys())
  let grew = true
  while (grew) {
    grew = false
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (deletion.has(header.id)) continue
      if (header.origin !== 'subagent') continue
      if (header.parentSession === undefined || !deletion.has(header.parentSession)) continue
      if (state.members.has(header.id)) continue
      if (live.has(header.id)) {
        skippedLive.push(header.id)
        continue
      }
      deletion.add(header.id)
      grew = true
    }
  }

  const warnings = warningBag()
  const deleted = []
  const deletedTasks = []
  if (config.orphanSweep && !state.ok) warnings.push('Workspace registry unreadable: orphan sweep skipped for this run.')
  for (const id of skippedLive) warnings.push(`Subagent ${id} is running and was skipped.`)

  // 1. Local artifacts first: nothing durable is destroyed elsewhere until the
  //    logs are actually gone. A session whose log survived keeps its account.
  const failed = new Set()
  for (const id of deletion) {
    const snapshot = byId.get(id)
    const logPath = snapshot?.location?.path
    let bytes = 0
    let logGone = logPath === undefined
    try {
      if (logPath !== undefined) {
        if (!isSessionLogPath(home, logPath)) throw new Error('stored log path is outside the session store')
        const dir = dirnameOf(logPath)
        bytes += sizeOf(dir)
        try {
          removePath(dir)
        } catch (error) {
          if (existsSync(logPath)) throw error
          warnings.push(`Session ${id}: directory leftovers could not be removed.`)
        }
        logGone = !existsSync(logPath)
      }
      const projected = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
      bytes += sizeOf(projected)
      removePath(projected)
      for (const spillDir of spillDirsOf(id)) {
        bytes += sizeOf(spillDir)
        removePath(spillDir)
      }
      if (!logGone) throw new Error('session log still present')
      deleted.push({ id, kind: seeds.get(id) ?? 'subagent', bytes })
    } catch (error) {
      failed.add(id)
      warnings.push(`Session ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2. Scheduled tasks that reference a removed session go with it (after the
  //    logs), so a failed file removal never destroys a live reminder.
  const removedIds = new Set(deleted.map((entry) => entry.id))
  const schedule = ctx.get('schedule')
  if (schedule !== undefined && typeof schedule.catalog === 'function') {
    let tasks = []
    try {
      tasks = await schedule.catalog()
    } catch (error) {
      warnings.push(`Scheduled tasks unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const task of tasks) {
      const involved = new Set(
        [
          ...(task.involvedSessionIds ?? []),
          task.target?.sessionId,
          task.lastDelivery?.targetSessionId,
          task.pendingDelivery?.targetSessionId,
        ].filter((value) => typeof value === 'string'),
      )
      if (![...involved].some((id) => removedIds.has(id))) continue
      try {
        await schedule.edit({ id: task.id, action: 'delete' })
        deletedTasks.push({ id: task.id, title: task.title ?? '' })
      } catch (error) {
        warnings.push(`Scheduled task ${task.id} could not be removed.`)
      }
    }
  }

  // 3. Workspace accounting: detach the slot, then clear pin/archive entries.
  const registry = ctx.workspaceRegistry
  for (const id of removedIds) {
    for (const entity of registry.list()) {
      if (typeof entity.detachSession !== 'function') {
        warnings.push('This Harness build does not expose workspace detachSession; the row may reappear after a reload.')
        break
      }
      try {
        await entity.detachSession(id)
      } catch (error) {
        warnings.push(`Workspace account could not be detached (the row may remain): ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
    await registry.unarchiveSession(id).catch(() => {
      warnings.push(`Archive entry cleanup failed (${id}).`)
    })
    await registry.unpinSession(id).catch(() => {
      warnings.push(`Pin entry cleanup failed (${id}).`)
    })
  }

  // 4. Tell the browser these summaries are gone, before the slow tail work.
  const removedList = [...removedIds]
  for (const id of removedList) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      warnings.push(`Browser removal notice failed (${id}).`)
    }
  }

  // 5. Background hygiene runs after this reply.
  setImmediate(() => {
    void cleanOrphanArtifacts(ctx, home).then(() => {
      if (config.attachmentSweep) return sweepAttachments(ctx, home, config)
    })
    setTimeout(() => {
      void cleanOrphanArtifacts(ctx, home)
    }, 15000)
  })

  return {
    deleted,
    deletedTasks,
    orphansDeleted: deleted.filter(
      (entry) => entry.id !== requested && entry.kind !== 'subagent' && seeds.get(entry.id) !== undefined,
    ),
    removedIds: removedList,
    partialFailure: failed.size > 0,
    attachmentsDeferred: config.attachmentSweep,
    warnings: warnings.list(),
  }
}

/** Directory of one file path. */
function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut <= 0 ? path : path.slice(0, cut)
}

/**
 * Mount the routes.
 * @param ctx - Host context.
 * @param rawConfig - Loader config.
 */
export function apply(ctx, rawConfig) {
  const config = parseConfig(rawConfig)
  if (config.diagnostics) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: PROBE,
          handler: (req, res) => {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({ version: VERSION, config }))
          },
        }),
      `session-scrub: probe ${PROBE}`,
    )
  }
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: STATUS_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () =>
          json(200, {
            ok: true,
            version: VERSION,
            running: sweepStatus.running,
            released: sweepStatus.released,
            kept: sweepStatus.kept,
            failed: sweepStatus.failed,
            cacheCleared: sweepStatus.cacheCleared,
            error: sweepStatus.error,
            startedAt: sweepStatus.startedAt,
            finishedAt: sweepStatus.finishedAt,
          }),
      }),
    `session-scrub: GET ${STATUS_ROUTE}`,
  )
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return json(400, { ok: false, error: { code: 'bad-request', message: 'body is not JSON' } })
          }
          if (body === null || typeof body !== 'object') {
            return json(400, { ok: false, error: { code: 'bad-request', message: 'body is not an object' } })
          }
          try {
            return json(200, { ok: true, value: await scrubSession(ctx, body, config) })
          } catch (error) {
            if (error instanceof Refusal) {
              return json(409, { ok: false, error: { code: error.code, message: error.message } })
            }
            ctx.logger.warn(`session-scrub: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
            return json(500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
          }
        },
      }),
    `session-scrub: POST ${ROUTE}`,
  )
}