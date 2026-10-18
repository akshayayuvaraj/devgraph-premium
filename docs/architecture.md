# Architecture
Node.js 22 / Express / FalkorDB (Cypher via the official client). Static UI (`public/`): landing `index.html`, app `app.html`, shared `styles.css`, SVG brand in `public/brand/`.

## How the graph drives the agent (`src/agent.js`)
1. **Plan**: services in the question are matched against `Service` nodes (optionally by an LLM, validated against that allowlist). The question's **intent** (impact, history, expertise, path, next-action) selects which graph tools run; skipped tools are listed in the trace.
2. **Traverse**: `find_service_dependencies` (DEPENDS_ON up to 4 hops + USES), `find_related_incidents` (AFFECTS + RELATED_TO up to 2 hops), `find_developer_expertise` (OWNS/RESOLVED scoring), `trace_relationship_path` (directed shortestPath, both directions), `recall_memory` (owner-scoped).
3. **Let results steer**: scope widens to downstream services; if the target has no incidents the agent expands to upstream dependencies and labels those findings *inferred, possible cause only*; expertise is evaluated on the services that results made relevant.
4. **Evidence model**: every fact becomes an evidence item `E1..En`, typed `direct` (a stored edge) or `inferred` (derived), carrying its tool and relationships. Conclusions and the recommendation cite evidence ids.
5. **Uncertainty**: contradictions (resolved without resolution, non-resolved with a resolver, open with a resolution, dependency cycles) and gaps (missing owners, no incidents, no edges, no path).
6. **Recommend**: priority = explainable score (downstream x2 + projects + open incidents x3 + critical x2). The highest-severity open incident yields a *proposed* `create_task`, assigned from ownership/resolution edges and citing evidence. Nothing is written by the agent.
7. **Act (human in the loop)**: `POST /api/tasks` requires `confirm:true`, an analyst role, validates everything before writing, and links the task to the investigation (`FROM_INVESTIGATION`); the UI reads the outcome back from the graph. A failure creates nothing and is reported as a failure.
8. **Remember**: the investigation, a snapshot (downstream set, open incidents), the recommendation, a lesson and the full decision trace are stored per user. On recall, the snapshot is compared with the current graph; changes are reported, and the older memory is marked `stale` and linked by `SUPERSEDES`.
9. **Explain**: with an LLM configured, it writes the explanation from bounded evidence JSON; answers citing non-existent evidence ids are rejected. Without one, a deterministic evidence-only answer is produced. The mode is always labelled.

Multi-agent coordination was deliberately **not** implemented: a single traceable agent is more reliable than labels simulating several.

## Safety
Own graph only (`devgraph-premium`; `devgraph`/`devgraph-test` refused); explicit guarded seed; parameterized Cypher; scrypt passwords; HttpOnly SameSite=Strict sessions; CSRF header; roles (viewer/analyst/admin); rate limits in FalkorDB's Redis layer; security headers; scrubbed errors; audit log.
