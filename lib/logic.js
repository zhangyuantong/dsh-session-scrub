/**
 * Pure helpers for `dsh-session-scrub`.
 *
 * Everything here is side-effect free so it can be unit tested without a
 * running Harness: configuration normalisation, path derivation, orphan
 * selection, attachment-reference parsing and bounded warning collection.
 *
 * @module dsh-session-scrub/logic
 */

import { dirname } from 'node:path'

/** Defaults for every option this plugin accepts. */
export const DEFAULTS = Object.freeze({
  attachmentSweep: true,
  orphanSweep: true,
  orphanMinimumAgeHours: 24,
  draftGraceMinutes: 60,
  sweepBudgetSeconds: 90,
  diagnostics: false,
})

const HOUR_MS = 60 * 60 * 1000

/**
 * Normalise an untrusted plugin config object.
 * @param raw - whatever the Loader passed.
 * @returns a complete, validated configuration.
 */
export function parseConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (value, fallback, minimum) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback
  return {
    attachmentSweep: source.attachmentSweep === undefined ? DEFAULTS.attachmentSweep : source.attachmentSweep === true,
    orphanSweep: source.orphanSweep === undefined ? DEFAULTS.orphanSweep : source.orphanSweep === true,
    orphanMinimumAgeHours: number(source.orphanMinimumAgeHours, DEFAULTS.orphanMinimumAgeHours, 0),
    draftGraceMinutes: number(source.draftGraceMinutes, DEFAULTS.draftGraceMinutes, 0),
    sweepBudgetSeconds: number(source.sweepBudgetSeconds, DEFAULTS.sweepBudgetSeconds, 5),
    diagnostics: source.diagnostics === true,
  }
}

/**
 * Derive the harness home from one stored session log path
 * (`<home>/sessions/<project>/<session>/<log>`).
 * @param logPath - absolute stored log path.
 * @returns the harness home directory.
 */
export function homeOf(logPath) {
  let current = logPath
  for (let step = 0; step < 4; step += 1) current = dirname(current)
  return current
}

/**
 * Collect attachment digests cited by serialized session events.
 * @param text - serialized events (or any text).
 * @returns referenced digests without the `sha256:` prefix.
 */
export function pickAttachmentDigests(text) {
  const digests = new Set()
  for (const match of text.match(/sha256:[a-f0-9]{64}/g) ?? []) digests.add(match.slice('sha256:'.length))
  return digests
}

/**
 * Select sessions that belong to nobody: absent from every workspace account,
 * not live in this process, old enough to have settled, and — for subagent
 * children — only when their parent log is gone too.
 *
 * @param snapshots - persistence snapshots carrying `header`.
 * @param members - ids accounted by any workspace.
 * @param liveIds - ids currently loaded in this process.
 * @param excluded - ids the caller is deleting anyway.
 * @param minimumAgeMs - age gate for ordinary sessions.
 * @param now - clock injection for tests.
 * @returns `{id, kind}` rows for the caller to delete.
 */
export function findOrphans(snapshots, members, liveIds, excluded, minimumAgeMs, now = Date.now()) {
  const known = new Set(snapshots.map((snapshot) => snapshot.header.id))
  const orphans = []
  for (const snapshot of snapshots) {
    const header = snapshot.header
    if (excluded.has(header.id) || members.has(header.id) || liveIds.has(header.id)) continue
    if (header.origin === 'subagent') {
      if (header.parentSession !== undefined && !known.has(header.parentSession)) {
        orphans.push({ id: header.id, kind: 'orphan-subagent' })
      }
      continue
    }
    if (typeof header.createdAt === 'number' && now - header.createdAt < minimumAgeMs) continue
    orphans.push({ id: header.id, kind: 'orphan-session' })
  }
  return orphans
}

/**
 * Bounded warning collector: one dialog line per failure category, never one
 * line per file.
 * @param limit - kept lines before the rest collapse into a count.
 * @returns `push(message)` and `list()`.
 */
export function warningBag(limit = 5) {
  const items = []
  let dropped = 0
  return {
    push(message) {
      if (items.length < limit) items.push(message)
      else dropped += 1
    },
    list() {
      return dropped === 0 ? items : [...items, `另有 ${dropped} 条同类提示已省略。`]
    },
    get size() {
      return items.length + dropped
    },
  }
}

/**
 * Whether a stored log path lives inside the sessions root of `home`.
 * Guards against ever deleting a directory outside the session store.
 * @param home - harness home.
 * @param logPath - stored log path from persistence.
 * @returns true when the log sits under `<home>/sessions/<project>/<session>/`.
 */
export function isSessionLogPath(home, logPath) {
  if (typeof logPath !== 'string' || logPath === '') return false
  const normalized = logPath.replaceAll('\\', '/')
  const root = `${home.replaceAll('\\', '/')}/sessions/`
  if (!normalized.toLowerCase().startsWith(root.toLowerCase())) return false
  const relative = normalized.slice(root.length).split('/')
  return relative.length === 3 && relative[0] !== '' && relative[1] !== '' && relative[2] !== ''
}

/** Milliseconds in one hour, exported for callers and tests. */
export const HOUR = HOUR_MS