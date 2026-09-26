// att-admin: lets HR manage app accounts (HR / scan-only kiosk) from inside the app.
// Only callers whose att_staff.role = 'hr' may use it. Uses the service role, which never leaves the server.
import { createClient } from 'npm:@supabase/supabase-js@2';

const USERNAME_DOMAIN = 'att.local'; // accounts made here log in with a plain username, stored as <name>@att.local
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function toEmail(login: string): string | null {
  const v = login.trim().toLowerCase();
  if (v.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
  return /^[a-z0-9._-]{3,30}$/.test(v) ? `${v}@${USERNAME_DOMAIN}` : null;
}
const validRole = (r: unknown): r is 'hr' | 'kiosk' => r === 'hr' || r === 'kiosk';
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 8 && p.length <= 72;

async function hrCount(): Promise<number> {
  const { count } = await admin.from('att_staff').select('user_id', { count: 'exact', head: true }).eq('role', 'hr');
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('method not allowed', 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return fail('กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await admin.from('att_staff').select('role').eq('user_id', user.id).maybeSingle();
  if (me?.role !== 'hr') return fail('เฉพาะบัญชี HR เท่านั้น', 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('ข้อมูลไม่ถูกต้อง'); }

  switch (body.action) {
    case 'list': {
      const { data, error } = await admin.from('att_staff').select('user_id, email, role, created_at').order('created_at');
      if (error) return fail(error.message, 500);
      return json({ users: data, me: user.id });
    }

    case 'create': {
      const email = toEmail(String(body.login ?? ''));
      if (!email) return fail('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษ/ตัวเลข 3–30 ตัว หรือเป็นอีเมล');
      if (!validPassword(body.password)) return fail('รหัสผ่านต้องยาว 8 ตัวขึ้นไป');
      if (!validRole(body.role)) return fail('ประเภทบัญชีไม่ถูกต้อง');
      const { data, error } = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true });
      if (error) return fail(/already|registered|exists/i.test(error.message) ? 'มีบัญชีชื่อนี้อยู่แล้ว' : error.message);
      const { error: e2 } = await admin.from('att_staff').insert({ user_id: data.user.id, email, role: body.role });
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); return fail(e2.message, 500); }
      return json({ ok: true });
    }

    case 'password': {
      const id = String(body.user_id ?? '');
      if (!validPassword(body.password)) return fail('รหัสผ่านต้องยาว 8 ตัวขึ้นไป');
      const { data: target } = await admin.from('att_staff').select('user_id').eq('user_id', id).maybeSingle();
      if (!target) return fail('ไม่พบบัญชีนี้', 404);
      const { error } = await admin.auth.admin.updateUserById(id, { password: body.password });
      if (error) return fail(error.message, 500);
      return json({ ok: true });
    }

    case 'role': {
      const id = String(body.user_id ?? '');
      if (!validRole(body.role)) return fail('ประเภทบัญชีไม่ถูกต้อง');
      if (id === user.id) return fail('เปลี่ยนประเภทบัญชีของตัวเองไม่ได้');
      const { error } = await admin.from('att_staff').update({ role: body.role }).eq('user_id', id);
      if (error) return fail(error.message, 500);
      return json({ ok: true });
    }

    case 'revoke': {
      const id = String(body.user_id ?? '');
      if (id === user.id) return fail('ลบสิทธิ์ของตัวเองไม่ได้');
      const { data: target } = await admin.from('att_staff').select('email, role').eq('user_id', id).maybeSingle();
      if (!target) return fail('ไม่พบบัญชีนี้', 404);
      if (target.role === 'hr' && (await hrCount()) <= 1) return fail('ต้องมีบัญชี HR อย่างน้อย 1 บัญชี');
      const { error } = await admin.from('att_staff').delete().eq('user_id', id);
      if (error) return fail(error.message, 500);
      // accounts created by this app exist only for it, so remove the login too; other accounts only lose access
      if (String(target.email ?? '').endsWith('@' + USERNAME_DOMAIN)) await admin.auth.admin.deleteUser(id);
      return json({ ok: true });
    }

    default:
      return fail('unknown action');
  }
});
