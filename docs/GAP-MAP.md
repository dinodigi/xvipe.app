# Gap map — bridging "Pluggie won't do that" to 100% app customizability

> Living doc, started 2026-07-30 from the LIVE MCP surface (60 tools, verified
> identical to the 2026-07-23 contract dump). The mission: every capability gap
> gets a named bridge — an XVibe seam, a Pluggie improvement (via the wall), or
> an honest "not yet" the agent says out loud. Never a fork, never client-side
> fake enforcement.

## 0. The four kinds of gap

| Kind | Bridge lane |
|---|---|
| **Unexposed** — Pluggie does it, XVibe's agent can't reach it | fix in this repo (tool allowlist + contract vocabulary) |
| **Deferred** — on Pluggie's backlog, not built yet | wall reports + Pluggie-side sprints (we own both sides) |
| **Rejected** — Pluggie will never do it (hosted code · raw SQL · expression language) | XVibe-side seams that respect the boundary |
| **Friction** — works, but rough edges | filed on the wall; UX mitigation in the studio |

## 1. Unexposed (fixed 2026-07-30 — biggest instant win)

The builder exposed 27/60 tools. Now ~50/60. What the agent gained:

- **Declarative cron** — `define_schedule`/`list_schedules`/`delete_schedule`:
  nightly sweeps, hold expiry, auto-archive. Apps get "background jobs" with
  zero compute.
- **Atomicity** — `transact` (multi-op + cross-op $refs + dryRun) and
  `update_entry_if` (CAS + increment): safe counters, inventory decrements,
  no-double-apply flows.
- **Aggregations** — `aggregate_entries` (count/sum/avg/min/max, groupBy):
  real in-app dashboards from the delivery of MCP-seeded stats.
- **Inbound email** — `configure_inbound`: apps that RECEIVE email into a
  collection (support inboxes, email-to-ticket).
- **Undo** — `list_entry_versions`/`restore_entry_version` + trash
  (`list_trash`/`restore_entry`): user-facing "restore" features.
- **SEO advisors** — `score_page`/`audit_site`/`fetch_page` (seo plugin).
- **Ops sight** — `get_changes`, `get_audit_log`, `list_jobs`/`cancel_job`,
  `list_connectors`, `get_entry`, `delete_asset`, `delete_block`.

Still deliberately excluded from the agent (destructive/ops-heavy, human-only):
`purge_entry`, `empty_trash`, `export_*`, `import_project`, `define_plugin`,
`delete_plugin`, `disable_plugin`, `revoke_delivery_token`, `refire_delivery`.

## 2. Deferred on Pluggie's backlog (bridge = the wall + Pluggie sprints)

| Gap | App impact | Status / bridge |
|---|---|---|
| Date-bucketed aggregates, 2nd groupBy | time-series charts in apps | top of Pluggie triage Track B — interim: client-side bucketing over paged reads (small data only) |
| Per-role workflow actors | "only admins approve" transitions | Track C — interim: claim-gated access + split collections |
| Capacity constraints (N per slot) | classes with 20 seats | Track F — interim: computed-unique keys give N=1 today |
| SMS connector | booking reminders by text | folds into the **connector-category idea filed 2026-07-30** |
| Third-party API connectors (OpenAI, Twilio…) | AI features, integrations in static apps | **filed on the wall 2026-07-30** — the single highest-value platform ask; XVibe surfacing is ready the day it ships |
| Scoped MCP tokens + OAuth (MT-1/D2/D3) | multi-user studio (Phase 2 door) | in flight Pluggie-side; XVibe's token seam is one function |
| Tenant subscriptions (BILL-1) | apps selling memberships | backlog; one-time checkout works today |
| Delivery-surface bulk writes (WP-7) | client-side CSV import | interim: looped POSTs + idempotency keys |
| Enum option renames | schema evolution nit | interim: add-new → migrate → confirmed drop |
| Semantic search, per-row ACL sharing | niche today | park |

Known-open friction (already tracked platform-side, don't re-file): no additive
field op on `define_collection` (full-replace + merge discipline), ~15s
delivery-plane convergence + `publicFilter` asymmetry.

## 3. Rejected forever — and the XVibe answers

| Pluggie will never | Because | XVibe's bridge |
|---|---|---|
| Host/sandbox tenant code | second infra business | **Phase 3: rented Cloudflare Workers, deployed and metered by XVibe** — the code home lives on OUR side of the fence when demand proves out (gates: abuse, cost caps, support) |
| Raw SQL | data plane integrity | growing query/aggregate vocabulary (Track B) + export for offline analysis |
| Rule expression language | unbounded eval = hosted code in disguise | grow the CLOSED vocabularies case-by-case (computed fns, constraint types, when-clauses) — every `send_feedback` "inexpressible rule" report is a vocabulary candidate |

## 4. Friction filed from this project (wall receipts)

1. Connector health false-negatives (bug, 2026-07-25) — r2/clerk/resend report
   error while R2 provably works.
2. publicWrite + claim-write interplay (agent-filed, 2026-07-25).
3. `get_client_code` missing update/remove for claim-gated collections
   (agent-filed, 2026-07-25).
4. Third-party connector category (idea, 2026-07-30) — the §2 headliner.

## 5. Operating rule

When a user asks for something outside the envelope: the agent (a) re-models
declaratively if it fits, (b) says plainly that it doesn't fit and files
`send_feedback`, (c) never fakes it in the browser, never invents a server.
The wall is the roadmap; this file is its index.
