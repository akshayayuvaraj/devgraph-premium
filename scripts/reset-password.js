// Offline recovery if every admin is locked out:  npm run reset-password -- user@example.com 'new-password-10+chars'
import { q } from '../src/db.js'; import { setPassword } from '../src/auth.js';
const [email, pw] = process.argv.slice(2);
if (!email || !pw || pw.length < 10) { console.error('usage: reset-password <email> <new password, 10+ chars>'); process.exit(1); }
const r = await q('MATCH (u:User {email:$e}) RETURN u.id AS id', { e: email.toLowerCase() });
if (!r.length) { console.error('no such user'); process.exit(1); }
await setPassword(r[0].id, pw); console.log('Password reset; all sessions revoked.'); process.exit(0);
