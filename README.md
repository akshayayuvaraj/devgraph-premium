# DevGraph AI Premium — traceable graph agent (TraceNova · Graph Hacks 2026 · Track 01)
A graph-driven incident-investigation agent on FalkorDB. The graph decides which tools run, what impact is inferred, what is flagged as conflicting or missing, and which action is *proposed*. Humans confirm actions; every investigation is stored as user-isolated memory and re-checked against the graph when recalled. It works without an LLM key (labelled evidence-only mode).

## Windows PowerShell setup (Node.js 22.9+)
Install this as a **new** folder. Never copy over your original `D:\devgraph`.
```powershell
node --version                                   # must print v22.9 or newer
Expand-Archive .\devgraph-premium.zip -DestinationPath D:\   # creates D:\devgraph-premium
cd D:\devgraph-premium
npm install
Copy-Item .env.example .env                      # then edit .env with your FalkorDB Cloud values (never commit it)
npm run init                                     # indexes only; creates no data
npm run seed:demo                                # OPTIONAL, explicit: labelled demo data; refuses unless FALKOR_GRAPH=devgraph-premium
npm start                                        # http://localhost:8080  (first account becomes admin)
```
## Environment variables (`.env`)
| Variable | Purpose |
|---|---|
| `FALKOR_HOST`, `FALKOR_PORT` | FalkorDB address |
| `FALKOR_USERNAME`, `FALKOR_PASSWORD`, `FALKOR_TLS=true` | FalkorDB Cloud authentication + TLS |
| `FALKOR_URL` | alternative single URL: `falkors://user:pass@host:port` |
| `FALKOR_GRAPH` | **`devgraph-premium`** (default). `devgraph` and `devgraph-test` are refused. |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | optional OpenAI-compatible model; leave empty for evidence-only |
| `PORT`, `ALLOW_SIGNUP`, `TRUST_PROXY`, `NODE_ENV` | server settings |
Credentials are never logged, returned by the API, or sent to the browser. The seed never runs on startup and deletes nothing.

## Tests
```powershell
npm test      # never reads .env; uses throwaway graphs named devgraph_test_<random> and drops only those
```
Without a reachable FalkorDB, live tests skip with a printed reason. To run them against your Cloud database, set the `FALKOR_*` variables in that PowerShell session (it creates and drops one temporary graph; it never touches `devgraph-premium`, `devgraph` or `devgraph-test`):
```powershell
$env:FALKOR_HOST='your-host'; $env:FALKOR_PORT='your-port'; $env:FALKOR_USERNAME='default'
$env:FALKOR_PASSWORD = Read-Host 'FalkorDB password'; $env:FALKOR_TLS='true'
npm test; Remove-Item Env:FALKOR_PASSWORD
```

## What is in the box
Landing page (`/`) and app (`/app.html`): Overview · Investigate (answer with clickable evidence citations, Decision Trace, memory influence, uncertainty, confirm-to-act) · Graph (search, type filter, labelled edges, zoom/pan, fit/reset, node inspector, highlighted evidence path) · Incidents (search, filters, owners, edit, tasks) · Memory (reopen stored traces, stale marking) · Settings (status, LLM test, users, audit). Original SVG brand: `public/brand/`. See `docs/architecture.md`, `docs/graph-schema.md`, `docs/demo-script.md`, `docs/security.md`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `ECONNREFUSED` | wrong host/port, or FalkorDB not running. Check `.env`; Cloud needs `FALKOR_TLS=true`. |
| `WRONGPASS` / `NOAUTH` | check `FALKOR_USERNAME`/`FALKOR_PASSWORD`; percent-encode special characters if using `FALKOR_URL`. |
| `gave up ... check ... TLS settings` | TLS mismatch: set `FALKOR_TLS=true` (or `falkors://`) for Cloud, omit it for local. |
| `FALKOR_GRAPH ... is protected` | set `FALKOR_GRAPH=devgraph-premium`. |
| Empty app, no data | run `npm run seed:demo` (demo) or load your own data; the app never invents data. |
| Graph panel stays blank | the graph library loads from cdnjs.cloudflare.com; allow it or check the network. |
| Port in use | set `PORT` in `.env`. |

## Verification status (honest)
**Verified in my sandbox** on a real FalkorDB engine (embedded `falkordblite`, Redis 8.6): 64/64 tests pass (twice in a row), including the judge flow on the demo scenario, graph-driven actions with provenance, stale-memory detection, memory isolation, the guarded seed, and the UI driven in jsdom. With no database: 27 pass, 37 skip, 0 fail. A pre-existing graph and a second "original project" graph were untouched by the tests. Earlier (previous build) I also verified password auth and TLS with certificate checks against that engine.
**Not verified:** your Windows machine; your FalkorDB Cloud instance (I have no access to it or to `D:\`); the official Docker image; real-browser rendering, visual layout and animations (only jsdom was used; screenshots were not taken); any real LLM provider (a mock server was used, including citation rejection and outages).
**Left out on purpose:** multi-agent coordination, MCP and graph-algorithm tools (PageRank etc.), light-theme logo auto-switching. Not production-ready: see "Not covered" in `docs/security.md` (no independent review, no MFA).
