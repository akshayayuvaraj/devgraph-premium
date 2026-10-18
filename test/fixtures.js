// TEST-ONLY fictional data. Loaded exclusively into a throwaway test graph and dropped afterwards. The application never uses it.
const services = ['auth-service','user-db','session-cache','api-gateway','payment-service','checkout-service','notification-service'];
const deps = [['api-gateway','auth-service'],['payment-service','auth-service'],['auth-service','user-db'],['auth-service','session-cache'],['checkout-service','payment-service'],['checkout-service','api-gateway'],['notification-service','user-db']];
const projects = [['Mobile App',['api-gateway']],['Web Storefront',['checkout-service']],['Admin Portal',['auth-service']],['Billing Engine',['payment-service']]];
const devs = [['Priya Nair',['auth-service'],['Redis','OAuth']],['Marcus Cole',['payment-service'],['Go','Postgres']],['Lena Ortiz',['api-gateway'],['Envoy','Kubernetes']],['Omar Hassan',['user-db'],['Postgres']]];
const incidents = [
  ['INC-087','Session cache eviction storm','high','session-cache','Raised maxmemory and switched to allkeys-lru.','Omar Hassan','2026-03-02'],
  ['INC-101','Auth token validation failures','critical','auth-service','Rotated expired signing key and added key-expiry monitor.','Priya Nair','2026-05-14'],
  ['INC-120','Payment timeouts under load','high','payment-service','Increased auth call timeout and added retry with backoff.','Marcus Cole','2026-07-09'],
  ['INC-133','Login latency spike','medium','auth-service','Added index on user-db sessions table.','Priya Nair','2026-08-21'],
  ['INC-140','Intermittent 502s at api-gateway','high','api-gateway','','','2026-10-12','open']];
const related = [['INC-101','INC-087'],['INC-120','INC-101'],['INC-133','INC-101'],['INC-140','INC-101']];
export async function loadFixtures(q) {
  for (const s of services) await q('MERGE (n:Service {id:$s}) SET n.name=$s', { s });
  for (const [a,b] of deps) await q('MATCH (a:Service {id:$a}),(b:Service {id:$b}) MERGE (a)-[:DEPENDS_ON]->(b)', { a, b });
  for (const [p,us] of projects) { await q('MERGE (n:Project {id:$p}) SET n.name=$p', { p });
    for (const s of us) await q('MATCH (p:Project {id:$p}),(s:Service {id:$s}) MERGE (p)-[:USES]->(s)', { p, s }); }
  for (const [d,owns,skills] of devs) { await q('MERGE (n:Developer {id:$d}) SET n.name=$d, n.skills=$skills', { d, skills });
    for (const s of owns) await q('MATCH (d:Developer {id:$d}),(s:Service {id:$s}) MERGE (d)-[:OWNS]->(s)', { d, s }); }
  for (const [id,title,sev,svc,res,dev,date,status='resolved'] of incidents) {
    await q('MERGE (i:Incident {id:$id}) SET i.name=$id, i.title=$title, i.severity=$sev, i.resolution=$res, i.date=$date, i.status=$status', { id,title,sev,res,date,status });
    await q('MATCH (i:Incident {id:$id}),(s:Service {id:$svc}) MERGE (i)-[:AFFECTS]->(s)', { id, svc });
    if (dev) await q('MATCH (i:Incident {id:$id}),(d:Developer {id:$dev}) MERGE (d)-[:RESOLVED]->(i)', { id, dev }); }
  for (const [a,b] of related) await q('MATCH (a:Incident {id:$a}),(b:Incident {id:$b}) MERGE (a)-[:RELATED_TO]->(b)', { a, b });
}
