/**
 * Browser half of `dsh-session-scrub`.
 *
 * Adds one row to the Session context menu, a confirmation dialog on
 * `shell.overlay` that reports background reclaim progress, and the
 * browser-local cleanup the Host cannot reach (composer draft, right-sidebar
 * layout, manual sidebar order, current selection).
 */

const ROUTE = '/api/dsh-session-scrub'
const STATUS_ROUTE = '/api/dsh-session-scrub-status'
const NS = 'sessionScrub'

window.__ModuleLoader__.load({
  id: 'dsh-session-scrub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = {
      'menu.delete': '彻底清理此会话',
      'dialog.title': '彻底清理会话',
      'dialog.titleDone': '清理完成',
      'dialog.confirm':
        '「{title}」将被彻底删除：会话记录、它的子代理会话、引用它的定时任务、它独占的附件与相关缓存。\n此操作不可撤销。',
      'dialog.confirmAnon': '此会话将被彻底删除，包括它的子代理会话、引用它的定时任务、独占附件与相关缓存。\n此操作不可撤销。',
      'action.cancel': '取消',
      'action.delete': '删除',
      'action.deleting': '删除中…',
      'action.close': '关闭',
      'result.deleted': '已删除会话 {n} 个。',
      'result.subagents': '连带子代理 {n} 个。',
      'result.tasks': '删除定时任务 {n} 个。',
      'result.orphans': '顺带清理孤儿会话 {n} 个。',
      'result.partial': '有 {n} 个会话未能完全删除，详见提醒。',
      'result.sweepPending': '附件与图片缓存正在后台回收…',
      'result.sweepRunning': '后台回收中：已回收附件 {n} 个…',
      'result.sweepDone': '后台回收完成：回收附件 {released} 个，保留 {kept} 个{failed}；图片缓存{cache}。',
      'result.sweepFailedSuffix': '，失败 {n} 个',
      'result.cacheCleared': '已清理',
      'result.cacheKept': '未清理',
      'result.sweepOff': '附件回收已在插件配置中关闭。',
      'result.sweepError': '回收出错：{error}',
      'result.warnings': '另有 {n} 条提醒：',
      'err.session-running': '该会话正在运行，无法删除。',
      'err.session-open': '当前会话被打开，无法删除。',
      'err.session-missing': '该会话已经不存在（可能已被删除）。',
      'err.bad-request': '请求格式无效。',
      'err.home-unknown': '无法确定 DSH 主目录，删除中止。',
      'err.network': '删除请求失败：{error}',
      'err.timeout': '删除请求超时（后台可能仍在继续）。',
      'err.unknown': '删除失败：{error}',
    }
    const en = {
      'menu.delete': 'Scrub this session',
      'dialog.title': 'Scrub session',
      'dialog.titleDone': 'Scrub finished',
      'dialog.confirm':
        '“{title}” will be permanently removed: its log, subagent children, scheduled tasks that reference it, and every attachment only it uses.\nThis cannot be undone.',
      'dialog.confirmAnon':
        'This session will be permanently removed, including its subagent children, scheduled tasks and attachments only it uses.\nThis cannot be undone.',
      'action.cancel': 'Cancel',
      'action.delete': 'Delete',
      'action.deleting': 'Deleting…',
      'action.close': 'Close',
      'result.deleted': 'Deleted {n} session(s).',
      'result.subagents': 'Including {n} subagent(s).',
      'result.tasks': 'Removed {n} scheduled task(s).',
      'result.orphans': 'Cleaned {n} orphan session(s).',
      'result.partial': '{n} session(s) were not fully removed — see warnings.',
      'result.sweepPending': 'Reclaiming attachments and image cache in the background…',
      'result.sweepRunning': 'Reclaiming: {n} attachment(s) released…',
      'result.sweepDone': 'Reclaim finished: {released} released, {kept} kept{failed}; image cache {cache}.',
      'result.sweepFailedSuffix': ', {n} failed',
      'result.cacheCleared': 'cleared',
      'result.cacheKept': 'kept',
      'result.sweepOff': 'Attachment reclaim is disabled in the plugin configuration.',
      'result.sweepError': 'Reclaim error: {error}',
      'result.warnings': '{n} more notice(s):',
      'err.session-running': 'This session is running and cannot be deleted.',
      'err.session-open': 'This session is open in the conversation view.',
      'err.session-missing': 'This session no longer exists.',
      'err.bad-request': 'The request was malformed.',
      'err.home-unknown': 'Cannot resolve the harness home directory; nothing was deleted.',
      'err.network': 'Delete request failed: {error}',
      'err.timeout': 'Delete request timed out (the background work may still continue).',
      'err.unknown': 'Delete failed: {error}',
    }

    /** Replace `{name}` placeholders in one localized template. */
    function fmt(template, values = {}) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    // ── pending dialog state ───────────────────────────────────────────────
    let pending = null
    const listeners = new Set()
    const publish = () => {
      for (const listener of [...listeners]) listener()
    }
    const openDialog = (next) => {
      pending = { status: 'idle', report: null, error: '', sweep: null, ...next }
      publish()
    }
    const patch = (fields) => {
      if (pending === null) return
      pending = { ...pending, ...fields }
      publish()
    }
    const settle = () => {
      pending = null
      publish()
    }
    function usePending() {
      const [value, setValue] = React.useState(pending)
      React.useEffect(() => {
        const listener = () => setValue(pending)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return value
    }

    // ── browser-local traces of one Session ────────────────────────────────
    /** Drop every string equal to the id from a persisted JSON value. */
    function scrub(value, id) {
      if (typeof value === 'string') return value === id ? undefined : value
      if (Array.isArray(value)) {
        return value
          .map((item) => scrub(item, id))
          .filter((item) => item !== undefined)
      }
      if (value !== null && typeof value === 'object') {
        const next = {}
        for (const [key, item] of Object.entries(value)) {
          if (item === id) continue
          const scrubbed = scrub(item, id)
          if (scrubbed !== undefined) next[key] = scrubbed
        }
        return next
      }
      return value
    }

    /** Remove the Session's draft, layout, order slot and selection. */
    function forgetLocal(id) {
      try {
        localStorage.removeItem(`dsh.conversation.${id}`)
        localStorage.removeItem(`dsh.sidebar-right.v1.${id}`)
        for (const key of ['dsh.workspace.view.v5', 'dsh.sessions.current']) {
          const raw = localStorage.getItem(key)
          if (raw === null) continue
          const next = scrub(JSON.parse(raw), id)
          if (next !== undefined) localStorage.setItem(key, JSON.stringify(next))
        }
      } catch {
        // Local storage is best effort: a browser that refuses it must not
        // block a Host-side deletion that already happened.
      }
    }

    /** The Session the main conversation view currently holds, if any. */
    function currentMainSessionId(ctx) {
      try {
        const sessions = ctx.get('sessions')
        const snapshot = sessions?.list?.getSnapshot?.()
        const byId = snapshot?.byId
        if (byId === undefined || byId === null) return null
        for (const session of Object.values(byId)) {
          if (((session?.retainedBy?.mainView ?? 0)) > 0) return session.id ?? null
        }
      } catch {
        // The guard is best effort; the Host still refuses running sessions.
      }
      return null
    }

    // ── presentation ───────────────────────────────────────────────────────
    const backdrop = {
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
    }
    const card = {
      width: '400px',
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      padding: '18px 18px 14px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: 1.6,
    }
    const titleStyle = { fontSize: '14px', fontWeight: 600, marginBottom: '8px' }
    const bodyStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'pre-wrap',
      maxHeight: '45vh',
      overflowY: 'auto',
      overflowWrap: 'anywhere',
    }
    const footerStyle = { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }
    const baseButton = {
      padding: '6px 14px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      cursor: 'pointer',
    }
    const dangerButton = {
      ...baseButton,
      border: '1px solid transparent',
      background: 'var(--dsw-alias-state-error-primary)',
      color: '#fff',
    }

    /** Build the result text from the Host payload plus sweep progress. */
    function summary(t, report, sweep) {
      const lines = []
      const sessions = Array.isArray(report.deleted) ? report.deleted : []
      const subagents = sessions.filter((entry) => entry.kind === 'subagent').length
      const top = sessions.length - subagents
      lines.push(fmt(t('result.deleted'), { n: top }))
      if (subagents > 0) lines.push(fmt(t('result.subagents'), { n: subagents }))
      if (Array.isArray(report.deletedTasks) && report.deletedTasks.length > 0) {
        lines.push(fmt(t('result.tasks'), { n: report.deletedTasks.length }))
      }
      if (Array.isArray(report.orphansDeleted) && report.orphansDeleted.length > 0) {
        lines.push(fmt(t('result.orphans'), { n: report.orphansDeleted.length }))
      }
      if (report.attachmentsDeferred !== true) {
        lines.push(t('result.sweepOff'))
      } else if (sweep === null || sweep === undefined) {
        lines.push(t('result.sweepPending'))
      } else if (sweep.running === true) {
        lines.push(fmt(t('result.sweepRunning'), { n: sweep.released ?? 0 }))
      } else {
        const failed = sweep.failed ?? 0
        lines.push(
          fmt(t('result.sweepDone'), {
            released: sweep.released ?? 0,
            kept: sweep.kept ?? 0,
            failed: failed > 0 ? fmt(t('result.sweepFailedSuffix'), { n: failed }) : '',
            cache: sweep.cacheCleared === true ? t('result.cacheCleared') : t('result.cacheKept'),
          }),
        )
        if (typeof sweep.error === 'string' && sweep.error !== '') {
          lines.push(fmt(t('result.sweepError'), { error: sweep.error }))
        }
      }
      if (Array.isArray(report.warnings) && report.warnings.length > 0) {
        lines.push('', fmt(t('result.warnings'), { n: report.warnings.length }), ...report.warnings.slice(0, 5))
      }
      return lines.join('\n')
    }

    /** Ask the Host to scrub the Session, then drop browser-local traces. */
    async function confirmScrub(t, target) {
      if (pending !== null && pending.status === 'running') return
      patch({ status: 'running', error: '', requestedAt: Date.now() })
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, 60000)
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: target.sessionId,
            currentSessionId: target.currentSessionId ?? null,
          }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) {
          const code = payload?.error?.code ?? 'unknown'
          const key = `err.${code}`
          const template = t(key)
          patch({
            status: 'idle',
            error:
              template === key
                ? fmt(t('err.unknown'), { error: payload?.error?.message ?? `HTTP ${response.status}` })
                : template,
          })
          return
        }
        const value = payload.value ?? {}
        for (const id of Array.isArray(value.removedIds) ? value.removedIds : [target.sessionId]) forgetLocal(id)
        patch({ status: 'idle', report: value })
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        patch({
          status: 'idle',
          error: aborted
            ? t('err.timeout')
            : fmt(t('err.network'), { error: error instanceof Error ? error.message : String(error) }),
        })
      } finally {
        clearTimeout(timer)
      }
    }

    /** The `shell.overlay` entry: nothing unless a scrub is pending. */
    function ScrubDialog({ t }) {
      const state = usePending()
      React.useEffect(() => {
        if (state === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') settle()
        }
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
        }
      }, [state === null])
      const report = state === null ? null : state.report
      // Poll the Host's sweep progress while the dialog stays open.
      React.useEffect(() => {
        if (report === null || report === undefined || report.attachmentsDeferred !== true) return undefined
        let alive = true
        let attempts = 0
        let timer = null
        const tick = async () => {
          attempts += 1
          try {
            const response = await fetch(STATUS_ROUTE, { cache: 'no-store' })
            const data = await response.json().catch(() => null)
            if (!alive) return
            if (data !== null && typeof data === 'object') {
              // Ignore a sweep that belongs to an earlier scrub.
              const requestedAt = typeof report.requestedAt === 'number' ? report.requestedAt : 0
              const startedAt = typeof data.startedAt === 'number' ? data.startedAt : 0
              if (startedAt >= requestedAt - 2000) {
                patch({ sweep: data })
                if (data.running !== true) return
              }
            }
          } catch {
            // A network hiccup must not stop the dialog from updating.
          }
          if (alive && attempts < 80) timer = setTimeout(tick, 1200)
        }
        timer = setTimeout(tick, 600)
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [report])
      if (state === null) return null
      const busy = state.status === 'running'
      const finished = state.report !== null || state.error !== ''
      const title = state.displayTitle !== undefined && state.displayTitle !== '' ? state.displayTitle : null
      const message =
        state.error !== ''
          ? state.error
          : state.report !== null
            ? summary(t, state.report, state.sweep)
            : title === null
              ? t('dialog.confirmAnon')
              : fmt(t('dialog.confirm'), { title })
      return h(
        'div',
        {
          style: backdrop,
          onClick: () => {
            if (!busy) settle()
          },
        },
        h(
          'div',
          {
            style: card,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('dialog.title'),
            onClick: (event) => {
              event.stopPropagation()
            },
          },
          h('div', { style: titleStyle }, state.report !== null ? t('dialog.titleDone') : t('dialog.title')),
          h('div', { style: bodyStyle }, message),
          h(
            'div',
            { style: footerStyle },
            h(
              'button',
              { type: 'button', style: baseButton, disabled: busy, onClick: settle },
              finished ? t('action.close') : t('action.cancel'),
            ),
            !finished
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: dangerButton,
                    disabled: busy,
                    onClick: () => {
                      confirmScrub(t, state)
                    },
                  },
                  busy ? t('action.deleting') : t('action.delete'),
                )
              : null,
          ),
        ),
      )
    }

    /** Trash glyph for the context-menu row. */
    function TrashIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5h6v2' }),
        h('path', { d: 'M6 7l1 13h10l1-13' }),
        h('path', { d: 'M10 11v6M14 11v6' }),
      )
    }

    return {
      inject: ['slots', 'contextMenus', 'sessions', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, 'zh', zh)
          ctx.locale.register(NS, 'en', en)
        } catch {
          // A locale registry that refuses duplicates still leaves the bound
          // dictionary from the first registration usable.
        }
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-session-scrub' }, TrashIcon),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-session-scrub-dialog' }, (props) =>
            h(ScrubDialog, { t: props?.t ?? t }),
          ),
        )
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'dsh-session-scrub',
              target: 'session',
              order: 900,
              resolve: ({ sessionId, displayTitle }) => [
                {
                  id: 'scrub',
                  label: t('menu.delete'),
                  icon: { key: 'dsh-session-scrub' },
                  danger: true,
                  separatorBefore: true,
                  run: () => {
                    openDialog({ sessionId, displayTitle, currentSessionId: currentMainSessionId(ctx) })
                  },
                },
              ],
            }),
          'session-scrub: context menu action',
        )
      },
    }
  },
})