import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  findOrphans,
  homeOf,
  isSessionLogPath,
  parseConfig,
  pickAttachmentDigests,
  warningBag,
} from '../lib/logic.js'

const HOUR = 60 * 60 * 1000

test('homeOf walks four levels up from a stored log', () => {
  const home = homeOf('C:\\Users\\me\\.dsh\\sessions\\--proj--\\session-a\\session.v4.jsonl.zstd')
  assert.equal(home, 'C:\\Users\\me\\.dsh')
  assert.equal(homeOf('/home/me/.dsh/sessions/p/s/log.zstd'), '/home/me/.dsh')
})

test('isSessionLogPath only admits logs inside the session store', () => {
  const home = 'C:\\Users\\me\\.dsh'
  assert.equal(isSessionLogPath(home, 'C:\\Users\\me\\.dsh\\sessions\\p\\s\\session.v4.jsonl.zstd'), true)
  assert.equal(isSessionLogPath(home, 'C:\\Users\\me\\.dsh\\sessions\\session.v4.jsonl.zstd'), false)
  assert.equal(isSessionLogPath(home, 'C:\\Users\\me\\.dsh\\sessions\\p\\s\\extra\\log.zstd'), false)
  assert.equal(isSessionLogPath(home, 'D:\\elsewhere\\sessions\\p\\s\\log.zstd'), false)
  assert.equal(isSessionLogPath(home, ''), false)
  assert.equal(isSessionLogPath(home, undefined), false)
})

test('pickAttachmentDigests reads only well-formed sha256 references', () => {
  const digest = 'a'.repeat(64)
  const text = `{"ref":"sha256:${digest}"} and "sha256:${'b'.repeat(32)}" plus sha256:${digest}`
  const found = pickAttachmentDigests(text)
  assert.deepEqual([...found], [digest])
  assert.equal(pickAttachmentDigests('nothing here').size, 0)
})

test('parseConfig normalizes untrusted input', () => {
  assert.deepEqual(parseConfig(undefined), { ...DEFAULTS })
  assert.deepEqual(parseConfig('nonsense'), { ...DEFAULTS })
  const custom = parseConfig({
    attachmentSweep: false,
    orphanSweep: 'yes',
    orphanMinimumAgeHours: 6,
    draftGraceMinutes: -5,
    sweepBudgetSeconds: 1,
    diagnostics: true,
  })
  assert.equal(custom.attachmentSweep, false)
  assert.equal(custom.orphanSweep, false)
  assert.equal(custom.orphanMinimumAgeHours, 6)
  assert.equal(custom.draftGraceMinutes, DEFAULTS.draftGraceMinutes)
  assert.equal(custom.sweepBudgetSeconds, DEFAULTS.sweepBudgetSeconds)
  assert.equal(custom.diagnostics, true)
})

const snap = (header) => ({ header })

test('findOrphans keeps accounted, live, young and parented sessions', () => {
  const now = 10 * HOUR
  const old = now - 48 * HOUR
  const snapshots = [
    snap({ id: 'accounted', origin: 'user', createdAt: old }),
    snap({ id: 'live', origin: 'user', createdAt: old }),
    snap({ id: 'young', origin: 'user', createdAt: now - HOUR }),
    snap({ id: 'orphan-old', origin: 'user', createdAt: old }),
    snap({ id: 'child-parent-alive', origin: 'subagent', parentSession: 'accounted', createdAt: old }),
    snap({ id: 'child-parent-gone', origin: 'subagent', parentSession: 'vanished', createdAt: old }),
    snap({ id: 'child-running', origin: 'subagent', parentSession: 'vanished', createdAt: old }),
    snap({ id: 'requested', origin: 'user', createdAt: old }),
  ]
  const orphans = findOrphans(
    snapshots,
    new Set(['accounted']),
    new Set(['live', 'child-running']),
    new Set(['requested']),
    24 * HOUR,
    now,
  )
  assert.deepEqual(orphans.map((row) => row.id).sort(), ['child-parent-gone', 'orphan-old'])
  assert.equal(orphans.find((row) => row.id === 'orphan-old').kind, 'orphan-session')
  assert.equal(orphans.find((row) => row.id === 'child-parent-gone').kind, 'orphan-subagent')
})

test('findOrphans never returns anything when every session is accounted', () => {
  const now = 10 * HOUR
  const snapshots = [snap({ id: 'a', origin: 'user', createdAt: now - 48 * HOUR })]
  assert.deepEqual(findOrphans(snapshots, new Set(['a']), new Set(), new Set(), 24 * HOUR, now), [])
})

test('warningBag collapses overflow into one line', () => {
  const bag = warningBag(2)
  bag.push('one')
  bag.push('two')
  bag.push('three')
  bag.push('four')
  assert.deepEqual(bag.list(), ['one', 'two', '另有 2 条同类提示已省略。'])
  assert.equal(bag.size, 4)
})