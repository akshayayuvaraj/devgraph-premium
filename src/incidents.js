import { randomUUID } from 'node:crypto';
import { q } from './db.js';
export const SEV = ['low', 'medium', 'high', 'critical'], STATUS = ['open', 'investigating', 'resolved'];
const fail = (m, status = 400) => Object.assign(new Error(m), { status });

export async function listIncidents({ search = '', severity = '', status = '' } = {}) {
  if (severity && !SEV.includes(severity)) throw fail('invalid severity');
  if (status && !STATUS.includes(status)) throw fail('invalid status');
  return q(`MATCH (i:Incident)-[:AFFECTS]->(s:Service)
    WHERE ($sev = '' OR i.severity = $sev) AND ($st = '' OR coalesce(i.status,'resolved') = $st)
      AND ($q = '' OR toLower(i.title) CONTAINS $q OR toLower(s.id) CONTAINS $q OR toLower(i.id) CONTAINS $q)
    OPTIONAL MATCH (d:Developer)-[:RESOLVED]->(i) OPTIONAL MATCH (p:Project)-[:USES]->(s) OPTIONAL MATCH (o:Developer)-[:OWNS]->(s)
    RETURN i.id AS id, i.title AS title, i.severity AS severity, coalesce(i.status,'resolved') AS status, i.date AS date, i.resolution AS resolution,
      s.id AS service, collect(DISTINCT d.id) AS resolvers, collect(DISTINCT p.id) AS projects, collect(DISTINCT o.id) AS owners ORDER BY i.date DESC LIMIT 100`,
    { sev: severity, st: status, q: String(search).slice(0, 60).toLowerCase() });
}
export async function createIncident({ title, severity, service, resolution = '' }) {
  title = String(title || '').trim();
  if (title.length < 3 || title.length > 120) throw fail('title must be 3-120 chars');
  if (!SEV.includes(severity)) throw fail('invalid severity');
  if (String(resolution).length > 500) throw fail('resolution too long');
  if (!(await q('MATCH (s:Service {id:$s}) RETURN s.id AS id', { s: String(service) })).length) throw fail('unknown service');
  const nums = (await q('MATCH (i:Incident) RETURN i.id AS id')).map(r => parseInt(String(r.id).replace(/\D/g, ''), 10) || 0);
  const id = 'INC-' + String(Math.max(0, ...nums) + 1).padStart(3, '0');   // note: not race-free under heavy concurrency
  await q('CREATE (i:Incident {id:$id, name:$id, title:$title, severity:$severity, status:"open", resolution:$resolution, date:$date})',
    { id, title, severity, resolution: String(resolution), date: new Date().toISOString().slice(0, 10) });
  await q('MATCH (i:Incident {id:$id}),(s:Service {id:$service}) MERGE (i)-[:AFFECTS]->(s)', { id, service });
  return id;
}
export async function updateIncident(id, body) {
  if (!(await q('MATCH (i:Incident {id:$id}) RETURN i.id AS id', { id })).length) throw fail('incident not found', 404);
  const changed = [];
  if (body.severity !== undefined) { if (!SEV.includes(body.severity)) throw fail('invalid severity'); await q('MATCH (i:Incident {id:$id}) SET i.severity=$v', { id, v: body.severity }); changed.push('severity'); }
  if (body.status !== undefined) { if (!STATUS.includes(body.status)) throw fail('invalid status'); await q('MATCH (i:Incident {id:$id}) SET i.status=$v', { id, v: body.status }); changed.push('status'); }
  if (body.resolution !== undefined) { if (String(body.resolution).length > 500) throw fail('resolution too long'); await q('MATCH (i:Incident {id:$id}) SET i.resolution=$v', { id, v: String(body.resolution) }); changed.push('resolution'); }
  if (!changed.length) throw fail('nothing to update');
  return changed;
}
export const TASK_STATUS = ['open', 'in_progress', 'done'];
// Validates everything BEFORE writing, so a failure never leaves a half-created task. `user` is the authenticated caller.
export async function createTask({ incidentId, title, developer, investigationId }, user) {
  title = String(title || '').trim(); if (title.length < 3 || title.length > 160) throw fail('title must be 3-160 chars');
  if (!(await q('MATCH (i:Incident {id:$id}) RETURN i.id AS id', { id: String(incidentId) })).length) throw fail('incident not found', 404);
  if (developer && !(await q('MATCH (d:Developer {id:$d}) RETURN d.id AS id', { d: String(developer) })).length) throw fail('unknown developer');
  if (investigationId && !(await q('MATCH (m:Investigation {id:$m, owner:$o}) RETURN m.id AS id', { m: String(investigationId), o: user.id })).length) throw fail('investigation not found', 404);
  const id = randomUUID();
  await q('MATCH (i:Incident {id:$inc}) CREATE (t:Task {id:$id, name:$title, title:$title, status:"open", created:$ts, createdBy:$by})-[:FOR]->(i)', { inc: incidentId, id, title, ts: Date.now(), by: user.id });
  if (developer) await q('MATCH (t:Task {id:$id}),(d:Developer {id:$d}) MERGE (t)-[:ASSIGNED_TO]->(d)', { id, d: String(developer) });
  if (investigationId) await q('MATCH (t:Task {id:$id}),(m:Investigation {id:$m, owner:$o}) MERGE (t)-[:FROM_INVESTIGATION]->(m) SET m.outcome=$out', { id, m: investigationId, o: user.id, out: `task created: ${title}` });
  return id;
}
export async function updateTask(id, { status }) {
  if (!TASK_STATUS.includes(status)) throw fail('invalid status');
  if (!(await q('MATCH (t:Task {id:$id}) RETURN t.id AS id', { id: String(id) })).length) throw fail('task not found', 404);
  await q('MATCH (t:Task {id:$id}) SET t.status=$s', { id: String(id), s: status });
}
export const listAllTasks = ({ status = '' } = {}) => {
  if (status && !TASK_STATUS.includes(status)) throw fail('invalid status');
  return q(`MATCH (t:Task) WHERE $st = '' OR t.status = $st OPTIONAL MATCH (t)-[:FOR]->(i:Incident) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(d:Developer)
    RETURN t.id AS id, t.title AS title, t.status AS status, t.created AS created, i.id AS incident, d.id AS developer ORDER BY t.created DESC LIMIT 100`, { st: status });
};
export const listTasks = (incidentId) => q('MATCH (t:Task)-[:FOR]->(i:Incident {id:$id}) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(d:Developer) RETURN t.id AS id, t.title AS title, t.status AS status, d.id AS developer ORDER BY t.created DESC LIMIT 50', { id: String(incidentId) });
export const listDevelopers = () => q('MATCH (d:Developer) RETURN d.id AS id ORDER BY d.id').then(r => r.map(x => x.id));
