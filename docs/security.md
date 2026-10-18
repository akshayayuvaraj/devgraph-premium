# Security notes

## Implemented
- **AuthN:** scrypt password hashes (per-user salt, timing-safe compare); random 256-bit session tokens in an HttpOnly, SameSite=Strict cookie (`Secure` when NODE_ENV=production); only a SHA-256 of the token is stored. 7-day sessions, expired ones purged on login.
- **Setup:** the first registered account becomes admin; there is no default account. Later signups are closed unless `ALLOW_SIGNUP=true`, and always get the `viewer` role.
- **Roles:** `viewer` (read, ask the agent, own memory) < `analyst` (create/update incidents and tasks) < `admin` (users, password resets, audit log). Enforced server-side on every route.
- **Password reset:** admin-initiated (confirmation required) or offline via `npm run reset-password`. Any reset or change revokes all of that user's sessions.
- **CSRF:** SameSite=Strict plus a required `X-Requested-With` header on every non-GET API request.
- **Rate limits:** counters in FalkorDB's Redis layer (shared across instances, persist across restarts); per-IP and per-account login throttles; in-memory fallback if the counter store is unreachable.
- **Injection:** all Cypher is parameterized; update fields and enums come from fixed allowlists; no user-supplied Cypher is ever executed. Traversals are depth- and row-limited.
- **Prompt injection:** graph rows, memories and questions are passed to the model as untrusted JSON data, and the model has no tools of its own.
- **Tenant isolation:** memories are matched on `owner` in every query; `User`, `Session` and `Audit` nodes are excluded from graph views.
- **Other:** 10 KB body limit, CSP / frame / nosniff headers, generic error messages, audit log of sensitive actions.

- **Database credentials:** read only from environment variables; never logged (errors are scrubbed), never returned by the API or sent to the browser. Remote connections without TLS log a warning. Tests use an isolated throwaway graph.

- **Graph isolation:** this project refuses the original project's graphs (`devgraph`, `devgraph-test`); the demo seed runs only on exactly `devgraph-premium` and never on startup.
- **Agent actions:** proposed by the agent, executed only by an authorized human after confirmation; validated before any write; provenance recorded; failures reported as failures.
- **LLM output:** bounded input, timeout, and answers citing non-existent evidence ids are rejected; status shown truthfully.

## Not covered / needs review before real production use
- **No independent security review or penetration test has been done.** These controls are a self-audit only.
- Incident IDs are assigned by max+1 and can collide under heavy concurrent writes.
- No MFA, email-based self-service reset, account lockout notification, or session listing.
- The audit log is writable only by the app, but is not tamper-evident.
- The CSP allows inline scripts/styles (single-file UI) and the vis-network CDN script; pin or self-host for stricter deployments.
- LLM output is rendered as escaped text, but the model could still produce misleading content; keep a human in the loop.
- Run behind HTTPS, keep FalkorDB on a private network (it has no auth by default; set a password or restrict access), and back up the data volume.
