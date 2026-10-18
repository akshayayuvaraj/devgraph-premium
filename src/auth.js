import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { q } from './db.js';
export const hashPw = (pw, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
export const verifyPw = (pw, stored) => { const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = scryptSync(pw, salt, 64); return a.length === b.length && timingSafeEqual(a, b); };
const sha = (t) => createHash('sha256').update(t).digest('hex');
const TTL = 7 * 24 * 3600 * 1000;
export const userCount = async () => (await q('MATCH (u:User) RETURN count(u) AS n'))[0].n;
export const RANK = { viewer: 1, analyst: 2, admin: 3 };
export const can = (role, min) => (RANK[role] || 0) >= RANK[min];
export async function register(email, pw, role = 'viewer') {
  if (!RANK[role]) throw Object.assign(new Error('invalid role'), { status: 400 });
  if (await q('MATCH (u:User {email:$email}) RETURN u.id AS id', { email }).then(r => r.length)) throw Object.assign(new Error('email already registered'), { status: 409 });
  const id = randomUUID();
  await q('CREATE (u:User {id:$id, email:$email, pw:$pw, role:$role, created:$ts})', { id, email, role, pw: hashPw(pw), ts: Date.now() });
  return id;
}
export async function login(email, pw) {
  const r = await q('MATCH (u:User {email:$email}) RETURN u.id AS id, u.pw AS pw', { email });
  if (!r.length || !verifyPw(pw, r[0].pw)) throw Object.assign(new Error('invalid credentials'), { status: 401 });
  return r[0].id;
}
export async function startSession(user) {          // only a hash of the token is stored
  const token = randomBytes(32).toString('hex');
  await q('CREATE (s:Session {id:$h, user:$user, exp:$exp})', { h: sha(token), user, exp: Date.now() + TTL });
  return token;
}
export async function userFromToken(token) {
  if (!token) return null;
  const r = await q('MATCH (s:Session {id:$h}) WHERE s.exp > $now MATCH (u:User {id:s.user}) RETURN u.id AS id, u.email AS email, coalesce(u.role,"viewer") AS role', { h: sha(token), now: Date.now() });
  return r[0] || null;
}
export const endSession = (token) => q('MATCH (s:Session {id:$h}) DELETE s', { h: sha(token || '') });
export const cookieOf = (req, n = 'devgraph_sid') => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === n)?.[1];
export const cookieHeader = (token, maxAge = TTL / 1000) =>
  `devgraph_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

export async function setPassword(id, pw) {   // also signs the user out everywhere
  await q('MATCH (u:User {id:$id}) SET u.pw=$pw', { id, pw: hashPw(pw) });
  await q('MATCH (s:Session {user:$id}) DELETE s', { id });
}
export async function changePassword(id, current, next) {
  const r = await q('MATCH (u:User {id:$id}) RETURN u.pw AS pw', { id });
  if (!r.length || !verifyPw(current, r[0].pw)) throw Object.assign(new Error('current password incorrect'), { status: 403 });
  await setPassword(id, next);
}
export const listUsers = () => q('MATCH (u:User) RETURN u.id AS id, u.email AS email, coalesce(u.role,"viewer") AS role, u.created AS created ORDER BY u.created');
export const purgeExpiredSessions = () => q('MATCH (s:Session) WHERE s.exp < $now DELETE s', { now: Date.now() });
export const audit = (user, action, target = '') => q('CREATE (:Audit {id:$id, user:$user, action:$action, target:$target, ts:$ts})', { id: randomUUID(), user, action, target, ts: Date.now() });
export const listAudit = () => q('MATCH (a:Audit) RETURN a.user AS user, a.action AS action, a.target AS target, a.ts AS ts ORDER BY a.ts DESC LIMIT 100');
