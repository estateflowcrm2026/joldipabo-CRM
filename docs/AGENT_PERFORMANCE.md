# Agent Performance reporting

`GET /api/v1/reports/agent-performance` ranks field executives from **real
visit and viewing records** — there are no manual counters, seed values, or
stored aggregates anywhere in this path. Every number is aggregated at query
time from `visits` (one row per scheduled site visit) joined to
`visit_viewings` (one row per property shown).

## Metrics (per agent)

| Metric | Source |
| --- | --- |
| Site visits handled | Distinct `visits` in range, by `assigned_to` |
| Clients assisted | Distinct `visits.lead_id` on visits having ≥ 1 `assisted` viewing |
| Properties shown | `visit_viewings` with `assistance_status = 'assisted'` |
| Completed visits | `visits.status = 'Completed'` |
| Cancelled / no-show visits | `visits.status` in `Cancelled`, `No Show`, `Visit cancelled`, `Client did not attend` |

The window filters `visits.scheduled_at`; a viewing counts with its visit,
not by its own `shown_at`. Soft-deleted visits are excluded. Rows are
ordered by site visits, then properties shown, then agent name.

## Filters

`?preset=weekly|monthly|yearly` covers the last 7 / 30 / 365 days ending now
(monthly is the default). `?preset=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`
selects whole calendar days inclusive, capped at 366 days. `&agentId=` narrows
to one executive. Invalid presets, inverted or overlong custom ranges, and
malformed dates return 400.

## Permissions

The coarse route gate is `reports:view`; the row predicate is
`visits:view` scope via `scopeFilterFor`, plus RLS tenant context
(`tenantQuery`) and explicit tenant predicates. A manager with team scope
sees only their team's agents; a field executive with own scope sees only
themself. Out-of-scope `agentId` values return an empty list, not 404.

## Frontend

The Reports view renders an `Agent Performance` panel only when the API
repository is active (`VITE_USE_API_REPOSITORY=true`); demo mode keeps its
seeded Reports screen and never calls this endpoint. The panel offers the
four ranges above and a dense ranked table — no charts.

## Verification

- Unit: `server/src/repositories/agentPerformanceRepository.test.js`
  (date-range resolution, filter validation).
- Live: `cd server` then `$env:AGENT_PERF_VERIFY_WRITE='1';
  npm run verify:agent-performance` — creates three synthetic visits (one
  recent completed with two assisted viewings, one recent cancelled, one old
  completed outside the monthly window), checks monthly/yearly/custom
  aggregation, the agent filter, 400s, and team/own scope, then removes the
  synthetic rows in a `finally` block. Audit events are retained.
- Frontend: `npm test` includes `src/services/agentPerformanceApi.test.mjs`
  (request shape only; no backend needed).
