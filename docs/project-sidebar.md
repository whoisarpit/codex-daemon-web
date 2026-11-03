# Project sidebar

Conversations are grouped by canonical Codex project IDs, not inferred from
working directories. Each group displays its project name and roots. Conversations
without a recognized project ID are placed under **No project**; cwd is preserved.
Projects sharing a display name remain distinct because their IDs differ.

The sidebar supports project and status grouping. Subagents appear under their
parent conversations using the parent-thread metadata. Thread status markers
can be configured in WebUI settings.

Groups can be sorted by recent activity or name. Conversations are ordered by
activity within groups; archived views use updated time. Browser preferences
store sorting and expansion choices. Search reveals matching nested agents.

Projects can be created from the sidebar using the official `project/create`
app-server method. Creation registers a name and one absolute root directory;
it does not create or move files. A stable idempotency key is reused when the
client retries an ambiguous request.

New conversations may be assigned to Codex projects, and existing conversations
may be moved using canonical Codex project membership operations.

## Verification

- `pnpm exec tsx tests/project-sidebar.test.ts`
- `pnpm exec tsx tests/sidebar-metadata.test.ts`
- `pnpm check`
- `pnpm build`

Tests cover canonical membership, unassigned threads, ordering, status grouping,
browser settings and nested parent-child agent presentation.
