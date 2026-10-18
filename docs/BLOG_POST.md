# Giving an incident-response agent a graph for a memory: building DevGraph AI on FalkorDB

When production breaks, the hard questions are about connections. What depends on this service? Which projects feel it? Who has fixed something like this before? A flat table or a vector search finds similar text, but it can't follow *depends on* three hops deep.

**DevGraph AI** puts that context in FalkorDB. Services, projects, developers and incidents are nodes. `DEPENDS_ON`, `USES`, `OWNS`, `RESOLVED`, `AFFECTS` and `RELATED_TO` are edges. The agent doesn't guess; it calls graph tools.

## The loop
1. The question is matched to services (an LLM picks from an allowlist when a key is set; keywords otherwise).
2. Bounded Cypher runs: `MATCH p=(d:Service)-[:DEPENDS_ON*1..4]->(f:Service {id:$s})` finds everything downstream, and projects are joined in. Incidents, expertise and `shortestPath` follow.
3. The model receives only those results, marked as untrusted data, and must cite ids. With no key, a deterministic summary is shown and labeled as such.
4. The investigation is saved as an `(:Investigation)-[:ABOUT]->(:Service)` node, so the next question about that service recalls it.

## Lessons
- **Parameterize everything.** User text never reaches Cypher as a string.
- **Make scoring explicit.** Developer ranking is `2 x owned services + 1 x resolved incidents`, and the UI can show why.
- **Say "I don't know".** If no service matches, the agent says the graph has insufficient evidence.
- **Memory belongs in the graph.** It's inspectable, deletable, per-user, and linked to the entities it concerns.

Run it: `npm install && npm run init && npm start`.
