# Graph schema (graph: `devgraph-premium`)
| Node | Key properties |
|---|---|
| `Service` | `id`, `name` |
| `Project` | `id`, `name` |
| `Developer` | `id`, `name`, `skills[]` |
| `Incident` | `id`, `name`, `title`, `severity` (low\|medium\|high\|critical), `status` (open\|investigating\|resolved), `date`, `resolution` |
| `Task` | `id`, `title`, `status` (open\|in_progress\|done), `created`, `createdBy` |
| `Investigation` (memory) | `id`, `owner`, `question`, `summary`, `ts`, `primary`, `snapshot` (JSON), `recommendation`, `lesson`, `llm`, `decision` (full decision trace JSON), `outcome`, `stale` |
| `User`, `Session`, `Audit` | accounts, hashed session tokens, audit log (never shown in the knowledge graph) |

| Relationship | Meaning |
|---|---|
| `(Service)-[:DEPENDS_ON]->(Service)` | caller depends on callee |
| `(Project)-[:USES]->(Service)` | project relies on service |
| `(Developer)-[:OWNS]->(Service)` | ownership |
| `(Developer)-[:RESOLVED]->(Incident)` | resolution history |
| `(Incident)-[:AFFECTS]->(Service)` | impact |
| `(Incident)-[:RELATED_TO]->(Incident)` | historical linkage (traversed up to 2 hops) |
| `(Task)-[:FOR]->(Incident)`, `(Task)-[:ASSIGNED_TO]->(Developer)` | follow-up work |
| `(Task)-[:FROM_INVESTIGATION]->(Investigation)` | **provenance** of an agent-proposed, human-confirmed action |
| `(Investigation)-[:ABOUT]->(Service)` | what a memory concerns |
| `(Investigation)-[:SUPERSEDES]->(Investigation)` | newer knowledge replaced stale knowledge |

Demo records carry `demo: true`; the UI shows a banner when any exist. Indexes (`id`) are created by `npm run init`; no data is inserted by it.
