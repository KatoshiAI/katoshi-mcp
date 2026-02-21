# Cloudflare Migration Plan (Railway -> Workers)

## Goal
Migrate the Katoshi MCP server from Railway (Node HTTP server) to Cloudflare Workers while preserving:
- MCP Streamable HTTP behavior
- existing tool contracts and outputs
- auth model (`api_key` + `id`)

## Current State Summary
- Entrypoint uses Node `http` server and `StreamableHTTPServerTransport`.
- Request context is propagated with `AsyncLocalStorage`.
- Tool logic is mostly runtime-agnostic, but some tools use outbound WebSockets (Hyperliquid snapshots).
- Config uses `process.env`.

## Target State Summary
- Entrypoint is a Cloudflare Worker `fetch(request, env, ctx)` handler.
- MCP served via Cloudflare-compatible transport (`createMcpHandler` or raw web-standard transport).
- Request context passed explicitly (no Node `AsyncLocalStorage` dependency).
- Secrets/config read from Worker bindings (`env`).

## Architecture Decision
Use `createMcpHandler` first (simpler Worker integration), with an option to switch to raw web-standard transport only if we need lower-level control.

## Phased Plan

## Phase 0: Preparation and Safety Rails
1. Add a `docs/` migration checklist and release gate criteria.
2. Freeze tool schema changes during migration window.
3. Define rollback path: keep Railway production live until Cloudflare parity is verified.

Deliverable:
- Signed-off migration checklist with owners and go/no-go criteria.

## Phase 1: Worker Skeleton (No Tool Logic Changes)
1. Add Worker entrypoint (`src/worker.ts` or similar) with:
   - `fetch(request, env, ctx)`
   - `/health` route parity
   - CORS parity
2. Add Worker config (`wrangler.toml`) with environment bindings for:
   - `KATOSHI_API_BASE_URL`
   - any additional keys currently read from env vars
3. Keep existing Railway entrypoint intact during this phase.

Deliverable:
- Worker deploys and returns health response in dev/staging.

## Phase 2: MCP Transport Migration
1. Replace Node-specific MCP request handling in Worker path:
   - move from `StreamableHTTPServerTransport` (Node req/res) to Cloudflare MCP handler.
2. Ensure stateless-per-request server creation remains true.
3. Keep identical JSON-RPC error behavior where possible (parse errors, unauthorized, internal errors).

Deliverable:
- `tools/list` and a basic `tools/call` succeed via Worker endpoint.

## Phase 3: Request Context Refactor
1. Remove dependency on `AsyncLocalStorage` for request-scoped auth context.
2. Introduce explicit context injection:
   - parse token/user at Worker edge
   - pass context into tool handlers (direct argument or request-scoped adapter)
3. Ensure no cross-request context leakage.

Deliverable:
- All tools resolve `apiKey`/`userId` correctly without Node async hooks.

## Phase 4: Environment and Secret Management
1. Replace `process.env` reads in runtime paths with Worker `env` bindings.
2. Define environment matrix:
   - local dev
   - staging
   - production
3. Add secret rotation procedure and naming conventions.

Deliverable:
- No runtime dependence on Node env globals in Worker path.

## Phase 5: WebSocket-Dependent Tool Validation
1. Inventory tools that rely on Hyperliquid WebSocket snapshots.
2. Validate Worker outbound WebSocket behavior under expected load and timeout profiles.
3. If limits are observed:
   - add conservative timeout/retry tuning
   - consider fallback implementation for specific tools

Deliverable:
- WebSocket-dependent tools pass functional and latency thresholds.

## Phase 6: Parity and Verification
1. Build a parity suite against Railway and Cloudflare:
   - `tools/list` equivalence
   - representative `tools/call` success cases
   - auth failure and malformed payload cases
2. Add smoke script for release gate.
3. Compare logs for response shape and error consistency.

Deliverable:
- Parity report signed off by engineering.

## Phase 7: Cutover
1. Put Cloudflare endpoint behind production domain.
2. Shift traffic gradually (if possible) or perform controlled switch.
3. Monitor error rate, p95 latency, and tool-specific failure rates.
4. Keep Railway hot-standby for rollback window.

Deliverable:
- Production traffic served by Cloudflare with SLO compliance.

## Phase 8: Cleanup
1. Remove deprecated Railway-only runtime code after rollback window ends.
2. Update README deployment documentation for Cloudflare-first workflow.
3. Archive migration notes and known limitations.

Deliverable:
- Single-source deployment path and updated operational docs.

## Key Risks and Mitigations
- Runtime mismatch (Node req/res vs Worker Request/Response):
  - Mitigation: isolate platform adapter layer and keep tool layer untouched.
- Request context propagation regression:
  - Mitigation: explicit typed context plumbing + tests for auth-dependent tools.
- WebSocket behavior/limits in Workers:
  - Mitigation: staged load tests and fallback strategy per affected tool.
- Behavior drift in MCP error responses:
  - Mitigation: contract tests for parse/auth/internal error shapes.

## Testing Strategy
- Unit:
  - auth extraction
  - context injection
  - transport adapter behavior
- Integration:
  - MCP `tools/list`
  - MCP `tools/call` for representative read/write tools
  - malformed JSON and unauthorized requests
- Staging soak:
  - repeated tool calls over time
  - monitoring for websocket and timeout failures

## Rollback Plan
1. Keep Railway deployment active during initial Cloudflare production rollout.
2. Maintain DNS/endpoint switch procedure to revert to Railway quickly.
3. Define explicit rollback triggers:
   - sustained elevated 5xx
   - auth/context corruption
   - critical tool failure rate above threshold

## Suggested Execution Order (Practical)
1. Phase 1 + Phase 2 in a feature branch.
2. Phase 3 immediately after transport is stable.
3. Phase 4 + Phase 5 before staging signoff.
4. Phase 6 report.
5. Phase 7 cutover.
6. Phase 8 cleanup.

## Open Decisions
1. Should we keep dual-runtime support (Railway + Worker) for a period after cutover?
2. What rollout strategy do we want: instant switch vs progressive traffic shift?
3. What are acceptable p95 and error-rate thresholds for go-live?

