# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-10

First public release.

### Added

- Session context-menu action **Scrub this session** (localized zh/en).
- Complete local cleanup of one session: log directory, subagent descendants,
  scheduled tasks that reference it, workspace accounting, pin/archive entries,
  projection-cache document, and per-session spill directories.
- Reference-aware attachment reclaim: attachment objects are removed only when
  no surviving session cites them, and only after a configurable draft grace
  window. A removed object also clears the derived request-image cache.
- Automatic orphan sweep after every scrub (sessions that no workspace accounts
  for, plus subagents whose parent log is gone).
- Live progress in the confirmation dialog while the background reclaim runs.
- Configuration: `attachmentSweep`, `orphanSweep`, `orphanMinimumAgeHours`,
  `draftGraceMinutes`, `sweepBudgetSeconds`, `diagnostics`.

### Safety

- Running sessions and the session open in the conversation view are refused.
- Running subagent children are skipped instead of deleted.
- An unreadable workspace registry skips the orphan sweep entirely rather than
  treating every session as unowned.
- Every removal path is verified against the session store, and a half-failed
  removal keeps its workspace slot instead of leaving a hidden log behind.

### Known limitations

- Deletion is irreversible; there is no recycle bin. Use `dsh-session-purge` if
  you want an undo window.
- Server-side copies of uploaded session logs are not deleted.
- Verified on DSH `0.2.2-rc.1`, Windows 11, Node 24. macOS/Linux untested.
- Workspace detach uses the non-public `detachSession` method; a Harness build
  without it reports a warning instead of silently failing.