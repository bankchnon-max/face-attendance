// att-line: LINE notifications for HR.
// Three kinds of callers, each authenticated differently (so the function is deployed without JWT checks):
//   1. LINE webhook (x-line-signature)  -> link a chat with a one-time code, forget chats that remove the bot
//   2. the database (x-internal-secret) -> new leave request, daily summary, low stock (stock app data)
//   3. HR in the app (user JWT, role hr) -> save bot keys, get a link code, list/remove chats, test
import { createClient } from 'npm:@supabase/supabase-js@2';

const APP_URL = 'https://bankchnon-max.github.io/face-attendance/';
const WEBHOOK_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/att-line`;
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

type Config = {
  channel_secret: string | null; channel_token: string | null; bot_name: string | null; bot_basic_id: string | null;
  link_code: string | null; link_code_expires: string | null; notify_leave: boolean; notify_daily: boolean; notify_stock: boolean; internal_secret: string;
};
async function getConfig(): Promise<Config> {
  const { data, error } = await admin.from('att_line_config').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as Config;
}
const setConfig = (patch: Partial<Config>) => admin.from('att_line_config').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);

async function lineApi(token: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LINE ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
async function pushAll(cfg: Config, text: string) {
  const { data: targets } = await admin.from('att_line_targets').select('line_id');
  let sent = 0;
  for (const t of targets ?? []) {
    try { await lineApi(cfg.channel_token!, 'message/push', { to: t.line_id, messages: [{ type: 'text', text: text.slice(0, 4900) }] }); sent++; }
    catch (e) { console.error('push failed', t.line_id, e); }
  }
  return sent;
}
async function validSignature(secret: string, raw: string, signature: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/* ---------- Thailand time helpers ---------- */
function bkk(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute), hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
const thDate = (key: string) => new Date(`${key}T12:00:00+07:00`).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const LEAVE = { sick: 'ลาป่วย', personal: 'ลากิจ', vacation: 'ลาพักร้อน', other: 'ลาอื่นๆ' } as Record<string, string>;
const PART = { full: 'เต็มวัน', am: 'ครึ่งวันเช้า', pm: 'ครึ่งวันบ่าย' } as Record<string, string>;

async function leaveMessage(id: string) {
  const { data: l } = await admin.from('att_leaves').select('*').eq('id', id).maybeSingle();
  if (!l || l.status !== 'pending') return null;
  const { data: e } = await admin.from('att_employees').select('name, dept').eq('id', l.emp_id).maybeSingle();
  const dates = l.start_date === l.end_date ? thDate(l.start_date) : `${thDate(l.start_date)} – ${thDate(l.end_date)}`;
  return [
    '📝 มีคำขอลาใหม่ รออนุมัติ',
    `ชื่อ: ${e?.name ?? '(ไม่พบชื่อ)'}${e?.dept ? ` (${e.dept})` : ''}`,
    `ประเภท: ${LEAVE[l.type] ?? l.type} · ${PART[l.part] ?? ''}`,
    `วันที่: ${dates}`,
    l.reason ? `เหตุผล: ${l.reason}` : '',
    '',
    `อนุมัติได้ที่: ${APP_URL}#leaves`,
  ].filter((x, i) => x !== '' || i === 5).join('\n');
}

async function dailyMessage() {
  const today = bkk(new Date()).key;
  const { data: evs } = await admin.from('att_events').select('emp_id, time, type, source')
    .gte('time', new Date(`${today}T00:00:00+07:00`).toISOString()).order('time');
  if (!evs?.length) return null;   // nobody came (factory holiday): no message
  const [{ data: emps }, { data: set }, { count: pending }] = await Promise.all([
    admin.from('att_employees').select('id, name'),
    admin.from('att_settings').select('data').eq('id', 1).maybeSingle(),
    admin.from('att_leaves').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  const s = { shiftStart: '08:30', grace: 5, lunchStart: '12:00', ...(set?.data ?? {}) } as Record<string, string | number>;
  const name = (id: string) => emps?.find(e => e.id === id)?.name ?? '(ลบแล้ว)';
  const people = new Map<string, { firstIn?: Date; out: boolean; manual?: string }>();
  for (const e of evs) {
    const p = people.get(e.emp_id) ?? { out: false };
    const t = new Date(e.time);
    if (e.type === 'in' && !p.firstIn) p.firstIn = t;
    if (e.type === 'out' && p.firstIn && t > p.firstIn) p.out = true;
    if (e.source === 'manual' && !p.manual) p.manual = bkk(t).hm;
    people.set(e.emp_id, p);
  }
  const came = [...people.entries()].filter(([, p]) => p.firstIn);
  const late = came.filter(([, p]) => { const m = bkk(p.firstIn!).min; return m > toMin(String(s.shiftStart)) + Number(s.grace) && m < toMin(String(s.lunchStart)); });
  const noOut = came.filter(([, p]) => !p.out).map(([id]) => name(id));
  const manual = [...people.entries()].filter(([, p]) => p.manual).map(([id, p]) => `${name(id)} (${p.manual})`);
  return [
    `📊 สรุปการลงเวลา ${thDate(today)}`,
    `มาทำงาน ${came.length} คน${late.length ? ` · มาสาย ${late.length} คน` : ''}`,
    noOut.length ? `⚠️ ยังไม่สแกนออก ${noOut.length} คน: ${noOut.join(', ')}` : '✅ ทุกคนสแกนออกครบ',
    manual.length ? `👆 ลงเวลาด้วยการเลือกชื่อ: ${manual.join(', ')}` : '',
    pending ? `📝 คำขอลารออนุมัติ ${pending} รายการ` : '',
    '',
    `ดูรายละเอียด: ${APP_URL}`,
  ].filter((x, i, a) => x !== '' || i === a.length - 2).join('\n');
}

/* ---------- สต๊อกใกล้หมด (ข้อมูลแอพสต๊อก + แอพผลิตใน kv_store) ----------
   เกณฑ์เดียวกับตาราง "⚠ ใกล้หมด" ในแอพสต๊อก:
   ใย = ต่ำกว่าจุดเตือนที่ตั้งไว้ · ผ้า = ม้วนที่ยังใช้ได้ ≤ 2 · ถุงซิล/ถุงแพ็ค = เหลือ < 5 กก. · ปลอกพร้อมผลิต = ต่ำกว่าจุดเตือนของประเภทสินค้า */
const STOCK_URL = 'https://production.winpolydesign.com/stock-app_1';
const r2 = (n: number) => Math.round(n * 100) / 100;
// deno-lint-ignore no-explicit-any
type Any = any;
async function kvJson(id: string): Promise<Any> {
  const { data } = await admin.from('kv_store').select('value').eq('id', id).maybeSingle();
  try { return data?.value ? JSON.parse(data.value) : {}; } catch { return {}; }
}
/* v3_feed ถูกแบ่งเก็บรายวัน (v3_feed~YYYY-MM-DD ตามสารบัญ v3_feed~idx) — รวมกลับเฉพาะส่วนที่ต้องใช้ */
async function feedLists(): Promise<{ wd: Any[]; bagWd: Any[]; fabricWd: Any[] }> {
  const out = { wd: [] as Any[], bagWd: [] as Any[], fabricWd: [] as Any[] };
  const idx = await kvJson('v3_feed~idx');
  const days = Object.keys(idx.days || {});
  const parts: Any[] = [];
  if (!days.length) parts.push(await kvJson('v3_feed'));
  for (let i = 0; i < days.length; i += 60) {
    const { data } = await admin.from('kv_store').select('value').in('id', days.slice(i, i + 60).map((d) => 'v3_feed~' + d));
    (data ?? []).forEach((r) => { try { parts.push(JSON.parse(r.value)); } catch { /* ข้ามก้อนเสีย */ } });
  }
  for (const p of parts) { out.wd.push(...(p.wd || [])); out.bagWd.push(...(p.bagWd || [])); out.fabricWd.push(...(p.fabricWd || [])); }
  return out;
}
function pieceLayout(widthIn: number, sizeStr: string) {
  const raw = String(sizeStr || ''), m = raw.match(/(\d+\.?\d*)\s*[xX×*]\s*(\d+\.?\d*)/);
  if (!m) return null;
  const k = /(ซม|เซน|\bcm\b)/i.test(raw) ? 2.54 : 1;
  let w = +m[1] / k, h = +m[2] / k;
  if (!w || !h) return null;
  if (widthIn && w > widthIn && h <= widthIn) { const t = w; w = h; h = t; }
  return { across: Math.max(1, widthIn ? Math.floor(widthIn / w) : 1), along: h };
}
function availableRolls(receipts: Any[], cuts: Any[], type: string, cutBatches: Any[]) {
  const mine = cuts.filter((c) => c.fabricType === type);
  const usedIds = new Set(mine.filter((c) => c.rollId).map((c) => c.rollId)), usedNos = new Set(mine.filter((c) => !c.rollId).map((c) => c.rollNo));
  return receipts.filter((r) => {
    if (r.fabricType !== type || r.retired) return false;
    if (!usedIds.has(r.id) && !usedNos.has(r.rollNo)) return true;
    if (!(r.widthIn && r.lengthIn)) return false;
    let used = 0;
    cutBatches.filter((b) => b.rollId ? b.rollId === r.id : (b.fabricType === r.fabricType && b.rollNo === r.rollNo)).forEach((b) => {
      const L = pieceLayout(r.widthIn, b.size); if (L) used += Math.ceil(b.qtyCut / L.across) * L.along; });
    return Math.max(0, r.lengthIn - used) >= 1;
  });
}
async function stockMessage(): Promise<string | null> {
  const [fib, fab, bag, feed] = await Promise.all([kvJson('v3s_fiber'), kvJson('v3s_fabric'), kvJson('v3s_bag'), feedLists()]);
  const lines: string[] = [];
  // ใย
  const th = fib.th || {}, rec: Record<string, number> = {}, used: Record<string, number> = {};
  (fib.receipts || []).forEach((r: Any) => { rec[r.fiberName] = (rec[r.fiberName] || 0) + (+r.kg || 0); });
  feed.wd.forEach((w: Any) => { used[w.fiberName] = (used[w.fiberName] || 0) + (+w.kg || 0); });
  const fiberLow = Object.keys(th).filter((n) => +th[n] > 0 && r2((rec[n] || 0) - (used[n] || 0)) < +th[n])
    .map((n) => `• ${n} เหลือ ${r2((rec[n] || 0) - (used[n] || 0)).toLocaleString('en-US')} กก. (เตือนต่ำกว่า ${(+th[n]).toLocaleString('en-US')})`);
  if (fiberLow.length) lines.push('🧶 ใย', ...fiberLow);
  // ผ้า
  const fr: Any[] = fab.receipts || [], cuts: Any[] = fab.cuts || [], cb: Any[] = fab.cutBatches || [];
  const fabLow = [...new Set(fr.map((r) => r.fabricType))].map((t) => ({ t, n: availableRolls(fr, cuts, t, cb).length }))
    .filter((x) => x.n <= 2).map((x) => `• ${x.t} เหลือ ${x.n} ม้วน`);
  if (fabLow.length) lines.push('🧵 ผ้า', ...fabLow);
  // ถุง
  const wdBySack: Record<string, number> = {};
  feed.bagWd.forEach((w: Any) => (w.picks || []).forEach((p: Any) => { wdBySack[p.sackId] = (wdBySack[p.sackId] || 0) + (+p.kg || 0); }));
  const agg: Record<string, { kind: string; name: string; kg: number; pcs: number }> = {};
  (bag.receipts || []).forEach((s: Any) => {
    const k = s.kind + '|' + s.name, left = (+s.sackWeightKg || 0) - (wdBySack[s.id] || 0);
    const a = agg[k] || (agg[k] = { kind: s.kind, name: s.name, kg: 0, pcs: 0 });
    a.kg += left; if (+s.weightPerBag > 0) a.pcs += Math.round(Math.max(0, left) / +s.weightPerBag);
  });
  for (const [kind, label] of [['zip', '🛍️ ถุงซิล'], ['pack', '📦 ถุงแพ็ค']]) {
    const low = Object.values(agg).filter((a) => a.kind === kind && r2(a.kg) < 5)
      .map((a) => `• ${a.name} เหลือ ${r2(Math.max(0, a.kg))} กก.${a.pcs ? ` (~${a.pcs.toLocaleString('en-US')} ใบ)` : ''}`);
    if (low.length) lines.push(label, ...low);
  }
  // ปลอกพร้อมผลิต ตามประเภทสินค้า (รับกลับจากช่าง − เบิกไปผลิต)
  const pth = fab.prodTypeTh || {};
  if (Object.keys(pth).some((t) => +pth[t] > 0)) {
    const ret: Record<string, number> = {}, wd: Record<string, number> = {}, pt: Record<string, string> = {};
    (fab.sewReturns || []).forEach((r: Any) => { ret[r.batchId] = (ret[r.batchId] || 0) + (+r.qty || 0); if (r.productType) pt[r.batchId] = r.productType; });
    feed.fabricWd.forEach((w: Any) => (w.picks || []).forEach((p: Any) => { wd[p.batchId] = (wd[p.batchId] || 0) + (+p.qty || 0); }));
    const ready: Record<string, number> = {};
    cb.forEach((b: Any) => { const t = pt[b.id], left = (ret[b.id] || 0) - (wd[b.id] || 0); if (t && left > 0) ready[t] = (ready[t] || 0) + left; });
    const low = Object.keys(pth).filter((t) => +pth[t] > 0 && (ready[t] || 0) < +pth[t])
      .map((t) => `• ${t} เหลือ ${r2(ready[t] || 0).toLocaleString('en-US')} ใบ (เตือนต่ำกว่า ${(+pth[t]).toLocaleString('en-US')})`);
    if (low.length) lines.push('🧺 ปลอกพร้อมผลิต', ...low);
  }
  if (!lines.length) return null;
  return [`⚠️ สต๊อกใกล้หมด · ${thDate(bkk(new Date()).key)}`, ...lines, '', `ดูในแอพสต๊อก: ${STOCK_URL}`].join('\n');
}

/* ---------- 1. LINE webhook ---------- */
async function handleWebhook(raw: string, signature: string) {
  const cfg = await getConfig();
  if (!cfg.channel_secret || !(await validSignature(cfg.channel_secret, raw, signature))) return fail('invalid signature', 401);
  const body = JSON.parse(raw);
  for (const ev of body.events ?? []) {
    const src = ev.source ?? {};
    const id: string | undefined = src.groupId ?? src.roomId ?? src.userId;
    const kind = src.groupId ? 'group' : src.roomId ? 'room' : 'user';
    if (!id) continue;
    if (ev.type === 'unfollow' || ev.type === 'leave') { await admin.from('att_line_targets').delete().eq('line_id', id); continue; }
    if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
    const m = String(ev.message.text).trim().match(/^(?:เชื่อม(?:ต่อ)?|link)\s*(\d{6})$/i);
    if (!m) continue;
    const ok = !!cfg.link_code && m[1] === cfg.link_code && !!cfg.link_code_expires && new Date(cfg.link_code_expires) > new Date();
    let reply = '❌ รหัสไม่ถูกต้องหรือหมดอายุ กรุณาสร้างรหัสใหม่ในแอป (ตั้งค่า → แจ้งเตือน LINE)';
    if (ok) {
      let label = kind === 'user' ? 'แชทส่วนตัว' : 'กลุ่ม';
      try {
        if (kind === 'user') label = (await lineApi(cfg.channel_token!, `profile/${id}`)).displayName ?? label;
        if (kind === 'group') label = (await lineApi(cfg.channel_token!, `group/${id}/summary`)).groupName ?? label;
      } catch { /* the name is only for display */ }
      await admin.from('att_line_targets').upsert({ line_id: id, kind, name: label });
      await setConfig({ link_code: null, link_code_expires: null });
      reply = `✅ เชื่อมต่อสำเร็จ ${kind === 'user' ? 'แชทนี้' : 'กลุ่มนี้'}จะได้รับแจ้งเตือนคำขอลา และสรุปการลงเวลาทุกวันเวลา 21:00`;
    }
    if (ev.replyToken) await lineApi(cfg.channel_token!, 'message/reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text: reply }] }).catch(console.error);
  }
  return json({ ok: true });
}

/* ---------- 2. database ---------- */
async function handleInternal(secret: string, body: Record<string, unknown>) {
  const cfg = await getConfig();
  if (secret !== cfg.internal_secret) return fail('forbidden', 403);
  if (!cfg.channel_token) return json({ skipped: 'not configured' });
  let text: string | null = null;
  if (body.type === 'leave' && cfg.notify_leave) text = await leaveMessage(String(body.id));
  if (body.type === 'daily' && cfg.notify_daily) text = await dailyMessage();
  if (body.type === 'stock' && cfg.notify_stock) text = await stockMessage();
  if (!text) return json({ skipped: true });
  return json({ sent: await pushAll(cfg, text) });
}

/* ---------- 3. HR in the app ---------- */
async function handleHr(token: string, body: Record<string, unknown>) {
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return fail('กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await admin.from('att_staff').select('role').eq('user_id', user.id).maybeSingle();
  if (me?.role !== 'hr') return fail('เฉพาะบัญชี HR เท่านั้น', 403);
  const cfg = await getConfig();

  switch (body.action) {
    case 'status': {
      const { data: targets } = await admin.from('att_line_targets').select('line_id, kind, name, created_at').order('created_at');
      const codeLive = cfg.link_code && cfg.link_code_expires && new Date(cfg.link_code_expires) > new Date();
      return json({
        configured: !!cfg.channel_token, botName: cfg.bot_name, basicId: cfg.bot_basic_id, webhookUrl: WEBHOOK_URL,
        notifyLeave: cfg.notify_leave, notifyDaily: cfg.notify_daily, notifyStock: cfg.notify_stock, targets: targets ?? [],
        code: codeLive ? cfg.link_code : null, codeExpires: codeLive ? cfg.link_code_expires : null,
      });
    }
    case 'save': {
      const secret = String(body.secret ?? '').trim(), tok = String(body.token ?? '').trim();
      if (!/^[0-9a-f]{32}$/i.test(secret)) return fail('Channel secret ต้องเป็นตัวอักษร 32 ตัว (0-9, a-f)');
      if (tok.length < 100) return fail('Channel access token สั้นเกินไป กรุณาคัดลอกให้ครบ');
      let info;
      try { info = await lineApi(tok, 'info'); } catch { return fail('ใช้ Channel access token นี้กับ LINE ไม่ได้ กรุณาตรวจสอบอีกครั้ง'); }
      await setConfig({ channel_secret: secret, channel_token: tok, bot_name: info.displayName ?? null, bot_basic_id: info.basicId ?? null });
      return json({ ok: true, botName: info.displayName, basicId: info.basicId });
    }
    case 'code': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const expires = new Date(Date.now() + 15 * 60000).toISOString();
      await setConfig({ link_code: code, link_code_expires: expires });
      return json({ code, expires });
    }
    case 'options': {
      await setConfig({ notify_leave: !!body.notifyLeave, notify_daily: !!body.notifyDaily, ...(body.notifyStock === undefined ? {} : { notify_stock: !!body.notifyStock }) });
      return json({ ok: true });
    }
    case 'remove': {
      await admin.from('att_line_targets').delete().eq('line_id', String(body.line_id ?? ''));
      return json({ ok: true });
    }
    case 'test': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const sent = await pushAll(cfg, '🔔 ทดสอบการแจ้งเตือนจากระบบลงเวลาใบหน้า\nถ้าเห็นข้อความนี้ แปลว่าการแจ้งเตือนใช้งานได้แล้ว');
      return json({ sent });
    }
    case 'summary-now': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const text = await dailyMessage();
      return json({ sent: text ? await pushAll(cfg, text) : 0, empty: !text });
    }
    case 'stock-preview': {
      return json({ text: await stockMessage() });
    }
    case 'stock-now': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const text = await stockMessage();
      return json({ sent: text ? await pushAll(cfg, text) : 0, empty: !text });
    }
    case 'disconnect': {
      await admin.from('att_line_targets').delete().neq('line_id', '');
      await setConfig({ channel_secret: null, channel_token: null, bot_name: null, bot_basic_id: null, link_code: null, link_code_expires: null });
      return json({ ok: true });
    }
    default:
      return fail('unknown action');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('method not allowed', 405);
  try {
    const raw = await req.text();
    const signature = req.headers.get('x-line-signature');
    if (signature) return await handleWebhook(raw, signature);
    const body = raw ? JSON.parse(raw) : {};
    const internal = req.headers.get('x-internal-secret');
    if (internal) return await handleInternal(internal, body);
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (token) return await handleHr(token, body);
    return fail('unauthorized', 401);
  } catch (e) {
    console.error(e);
    return fail('เกิดข้อผิดพลาด: ' + (e instanceof Error ? e.message : String(e)), 500);
  }
});
