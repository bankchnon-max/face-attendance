// att-line: LINE notifications for HR.
// Three kinds of callers, each authenticated differently (so the function is deployed without JWT checks):
//   1. LINE webhook (x-line-signature)  -> link a chat with a one-time code, forget chats that remove the bot,
//      link an HR person's LINE ("ผูก NNNNNN") and approve/reject leave from the buttons in the leave message,
//      answer typed commands in linked chats (สต๊อก · ต้นทุน [วันที่] · ลงเวลา · ลา · เตือน · เมนู), only for topics that chat receives
//   2. the database (x-internal-secret) -> new leave request, daily summary, morning (low stock + yesterday's cost + cost checks)
// Each chat (att_line_targets.topics) picks which topics it receives: leave · daily · stock · cost · alerts
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
  link_code: string | null; link_code_expires: string | null; notify_leave: boolean; notify_daily: boolean; notify_stock: boolean;
  notify_cost: boolean; notify_alerts: boolean; last_alerts: string | null; internal_secret: string;
  approver_code: string | null; approver_code_expires: string | null; approver_code_user: string | null;
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
const TOPICS = ['leave', 'daily', 'stock', 'cost', 'alerts'];
/* ส่งเฉพาะห้องที่เลือกเรื่องนี้ไว้ (topic ว่าง = ทุกห้อง เช่น ข้อความทดสอบ) */
/* messages: ใช้แทนข้อความธรรมดา (เช่น Flex ที่มีปุ่ม) */
async function pushAll(cfg: Config, text: string, topic?: string, messages?: unknown[]) {
  const { data: targets } = await admin.from('att_line_targets').select('line_id, topics');
  let sent = 0;
  for (const t of (targets ?? []).filter((x) => !topic || !Array.isArray(x.topics) || x.topics.includes(topic))) {
    try { await lineApi(cfg.channel_token!, 'message/push', { to: t.line_id, messages: messages ?? [{ type: 'text', text: text.slice(0, 4900) }] }); sent++; }
    catch (e) {
      console.error('push failed', t.line_id, e);
      /* Flex ส่งไม่ผ่าน → ส่งข้อความธรรมดาแทน ห้องนั้นจะได้ไม่พลาดแจ้งเตือน */
      if (messages) try { await lineApi(cfg.channel_token!, 'message/push', { to: t.line_id, messages: [{ type: 'text', text: text.slice(0, 4900) }] }); sent++; } catch { /* logged above */ }
    }
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

async function leaveInfo(id: string) {
  const { data: l } = await admin.from('att_leaves').select('*').eq('id', id).maybeSingle();
  if (!l) return null;
  const { data: e } = await admin.from('att_employees').select('name, dept').eq('id', l.emp_id).maybeSingle();
  const dates = l.start_date === l.end_date ? thDate(l.start_date) : `${thDate(l.start_date)} – ${thDate(l.end_date)}`;
  return { l, name: `${e?.name ?? '(ไม่พบชื่อ)'}${e?.dept ? ` (${e.dept})` : ''}`, what: `${LEAVE[l.type] ?? l.type} · ${PART[l.part] ?? ''}`, dates };
}
/* ข้อความคำขอลา: ข้อความธรรมดา (สำรอง/แจ้งเตือนบนมือถือ) + Flex ที่มีปุ่ม อนุมัติ / ไม่อนุมัติ */
async function leaveMessage(id: string, anyStatus = false) {
  const x = await leaveInfo(id);
  if (!x || (x.l.status !== 'pending' && !anyStatus)) return null;
  const text = [
    '📝 มีคำขอลาใหม่ รออนุมัติ',
    `ชื่อ: ${x.name}`,
    `ประเภท: ${x.what}`,
    `วันที่: ${x.dates}`,
    x.l.reason ? `เหตุผล: ${x.l.reason}` : '',
    '',
    `อนุมัติได้ที่: ${APP_URL}#leaves`,
  ].filter((v, i) => v !== '' || i === 5).join('\n');
  const row = (k: string, v: string) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [
    { type: 'text', text: k, size: 'sm', color: '#888888', flex: 2 }, { type: 'text', text: v || '-', size: 'sm', wrap: true, flex: 6 }] });
  const btn = (label: string, act: string, style: string, color?: string) => ({ type: 'button', style, height: 'sm', ...(color ? { color } : {}),
    action: { type: 'postback', label, data: `leave=${act}&id=${encodeURIComponent(id)}` } });
  const flex = { type: 'flex', altText: text.split('\n').slice(0, 4).join(' · ').slice(0, 390), contents: { type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: '📝 มีคำขอลาใหม่ รออนุมัติ', weight: 'bold', size: 'md', wrap: true },
      row('ชื่อ', x.name), row('ประเภท', x.what), row('วันที่', x.dates), ...(x.l.reason ? [row('เหตุผล', String(x.l.reason))] : [])] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [btn('✅ อนุมัติ', 'approve', 'primary', '#16a34a'), btn('❌ ไม่อนุมัติ', 'reject', 'secondary')] },
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'เปิดในแอพ (ใส่เหตุผลที่ไม่อนุมัติ)', uri: APP_URL + '#leaves' } }] } } };
  return { text, messages: [flex] };
}
/* กดปุ่มในข้อความลา: เฉพาะ LINE ที่ HR ผูกไว้ และ HR คนนั้นยังเป็น HR อยู่ */
async function decideFromLine(cfg: Config, lineUserId: string | undefined, id: string, act: string) {
  if (!lineUserId) return '⚠️ LINE ไม่ส่งข้อมูลว่าใครกด กรุณาอนุมัติในแอพ: ' + APP_URL + '#leaves';
  const { data: ap } = await admin.from('att_line_approvers').select('user_id, name').eq('line_user_id', lineUserId).maybeSingle();
  const { data: me } = ap ? await admin.from('att_staff').select('role').eq('user_id', ap.user_id).maybeSingle() : { data: null };
  if (!ap || me?.role !== 'hr') return '⛔ ไม่มีสิทธิ์อนุมัติ — ต้องเป็น HR ที่ผูก LINE ไว้แล้ว (แอพลงเวลา → ตั้งค่า → แจ้งเตือน LINE → ผู้อนุมัติลาทาง LINE)';
  const x = await leaveInfo(id);
  if (!x) return 'ไม่พบคำขอลานี้ (อาจถูกลบไปแล้ว)';
  const head = `${x.name} · ${x.what} · ${x.dates}`;
  const done = { approved: 'อนุมัติไปแล้ว', rejected: 'ไม่อนุมัติไปแล้ว', cancelled: 'ถูกยกเลิกไปแล้ว' } as Record<string, string>;
  if (x.l.status !== 'pending') return `ℹ️ รายการนี้${done[x.l.status] ?? x.l.status}${x.l.decided_at ? ' (' + thDate(bkk(new Date(x.l.decided_at)).key) + ' ' + bkk(new Date(x.l.decided_at)).hm + ' น.)' : ''}\n${head}`;
  const status = act === 'approve' ? 'approved' : 'rejected';
  /* เปลี่ยนเฉพาะที่ยังรออยู่ — กดพร้อมกันสองคน คนที่สองจะได้ "อนุมัติไปแล้ว" */
  const { data: upd, error } = await admin.from('att_leaves').update({ status, decided_by: ap.user_id, decided_at: new Date().toISOString(), decision_note: null })
    .eq('id', id).eq('status', 'pending').select('id');
  if (error) throw error;
  if (!upd?.length) return 'ℹ️ รายการนี้มีคนตัดสินไปแล้ว\n' + head;
  return (status === 'approved' ? '✅ อนุมัติแล้ว' : '❌ ไม่อนุมัติ') + `\n${head}\nโดย ${ap.name || 'HR'}` + (status === 'rejected' ? '\n(ใส่เหตุผลเพิ่มได้ในแอพ)' : '');
}

async function dailyMessage(live = false) {
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
    `📊 สรุปการลงเวลา ${thDate(today)}${live ? ` (ณ ${bkk(new Date()).hm} น.)` : ''}`,
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
   จุดเตือนตั้งในแอพสต๊อก (v3s_alert): ใย ทุกชนิด (ใยที่ตั้งรายชนิดไว้ใช้ค่านั้นก่อน) · ผ้า ม้วนที่ยังใช้ได้ ≤ ที่ตั้ง · ถุงแพ็ค/ถุงซิล แต่ละแบบ < ที่ตั้ง
   ปลอกพร้อมผลิต = ต่ำกว่าจุดเตือนของประเภทสินค้า · ใส่ 0 = ไม่เตือน */
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
    /* ถุงปกติทั้งถุง + ส่วนของถุงที่มีผ้าหลายม้วน (parts) */
    cutBatches.forEach((b) => {
      const qs = Array.isArray(b.parts) && b.parts.length ? b.parts.filter((p: Any) => p.rollId === r.id).map((p: Any) => +p.qty || 0)
        : ((b.rollId ? b.rollId === r.id : (b.fabricType === r.fabricType && b.rollNo === r.rollNo)) ? [+b.qtyCut || 0] : []);
      const L = qs.length ? pieceLayout(r.widthIn, b.size) : null;
      if (L) qs.forEach((q: number) => { used += Math.ceil(q / L.across) * L.along; });
    });
    return Math.max(0, r.lengthIn - used) >= 1;
  });
}
async function stockMessage(): Promise<string | null> {
  const [fib, fab, bag, feed, al] = await Promise.all([kvJson('v3s_fiber'), kvJson('v3s_fabric'), kvJson('v3s_bag'), feedLists(), kvJson('v3s_alert')]);
  const T = { fiberKg: 0, fabricRolls: 2, packKg: 5, zipKg: 5, ...al };
  const lines: string[] = [];
  // ใย
  const own = fib.th || {}, rec: Record<string, number> = {}, used: Record<string, number> = {};
  (fib.receipts || []).forEach((r: Any) => { rec[r.fiberName] = (rec[r.fiberName] || 0) + (+r.kg || 0); });
  feed.wd.forEach((w: Any) => { used[w.fiberName] = (used[w.fiberName] || 0) + (+w.kg || 0); });
  const thOf = (n: string) => +own[n] > 0 ? +own[n] : +T.fiberKg || 0;
  const fiberLow = Object.keys(rec).sort((a, b) => a.localeCompare(b, 'th'))
    .filter((n) => thOf(n) > 0 && r2((rec[n] || 0) - (used[n] || 0)) < thOf(n))
    .map((n) => `• ${n} เหลือ ${r2((rec[n] || 0) - (used[n] || 0)).toLocaleString('en-US')} กก. (เตือนต่ำกว่า ${thOf(n).toLocaleString('en-US')})`);
  if (fiberLow.length) lines.push('🧶 ใย', ...fiberLow);
  // ผ้า
  const fr: Any[] = fab.receipts || [], cuts: Any[] = fab.cuts || [], cb: Any[] = fab.cutBatches || [];
  const fabLow = [...new Set(fr.map((r) => r.fabricType))].map((t) => ({ t, n: availableRolls(fr, cuts, t, cb).length }))
    .filter((x) => +T.fabricRolls > 0 && x.n <= +T.fabricRolls).map((x) => `• ${x.t} เหลือ ${x.n} ม้วน (เตือนไม่เกิน ${+T.fabricRolls})`);
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
  for (const [kind, label, lim] of [['zip', '🛍️ ถุงซิล', +T.zipKg || 0], ['pack', '📦 ถุงแพ็ค', +T.packKg || 0]] as [string, string, number][]) {
    const low = Object.values(agg).filter((a) => a.kind === kind && r2(a.kg) < lim)
      .map((a) => `• ${a.name} เหลือ ${r2(Math.max(0, a.kg)).toLocaleString('en-US')} กก.${a.pcs ? ` (~${a.pcs.toLocaleString('en-US')} ใบ)` : ''}`);
    if (low.length) lines.push(`${label} (เตือนต่ำกว่า ${lim} กก.)`, ...low);
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

/* ---------- ต้นทุนเมื่อวาน + จุดที่ควรดู ----------
   ใช้บล็อก COST (คิดเงินล้วนๆ ไม่แตะหน้าจอ) จากแอพต้นทุนบนเว็บจริง — ตัวเลขตรงกับแอพเสมอ ไม่ต้องดูแลสองที่ */
const COST_APP_URL = 'https://production.winpolydesign.com/cost-app';
const r3 = (n: number) => Math.round(n * 1000) / 1000, r4 = (n: number) => Math.round(n * 10000) / 10000;
const fmtBaht = (n: number) => (Math.round((+n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(+n || 0).toLocaleString('en-US');
const thDateShort = (iso: string) => { const d = String(iso || '').slice(0, 10).split('-'); return d.length < 3 ? '' : (+d[2]) + '/' + (+d[1]) + '/' + (+d[0] + 543); };
async function loadCostCore(S: Any) {
  const html = await (await fetch(COST_APP_URL + '?nc=' + Date.now())).text();
  const a = html.indexOf('/* <cost-core> */'), b = html.indexOf('/* </cost-core> */');
  if (a < 0 || b < 0) throw new Error('cost-core not found in cost app');
  const src = html.slice(a, b);
  return new Function('r2', 'r3', 'r4', 'S', src + '\nreturn COST;')(r2, r3, r4, S);
}
/* ข้อมูลที่แบ่งเก็บรายวัน (v3_line / v3_feed) — ประกอบกลับทั้งก้อน */
async function splitAll(key: string): Promise<Any> {
  const idx = await kvJson(key + '~idx');
  const days = Object.keys(idx.days || {});
  if (!days.length) return kvJson(key);
  const out: Any = Object.assign({}, idx.rest || {});
  (idx.fields || []).forEach((k: string) => { out[k] = []; });
  for (let i = 0; i < days.length; i += 60) {
    const { data } = await admin.from('kv_store').select('value').in('id', days.slice(i, i + 60).map((d) => key + '~' + d));
    (data ?? []).forEach((r) => { try { const p = JSON.parse(r.value); (idx.fields || []).forEach((k: string) => { if (p[k]) out[k].push(...p[k]); }); } catch { /* ข้ามก้อนเสีย */ } });
  }
  return out;
}
async function costCtx() {
  const [fi, fa, bg, gs, ord, fd, ln, st, pr] = await Promise.all([kvJson('v3s_fiber'), kvJson('v3s_fabric'), kvJson('v3s_bag'), kvJson('v3s_gas'),
    kvJson('v3_orders'), splitAll('v3_feed'), splitAll('v3_line'), kvJson('v3k_set'), kvJson('v3k_price')]);
  const S = { fiberReceipts: fi.receipts || [], fabricReceipts: fa.receipts || [], cutBatches: fa.cutBatches || [], sewReturns: fa.sewReturns || [],
    sackReceipts: bg.receipts || [], reuseItems: bg.reuseItems || [], gasReceipts: gs.receipts || [] };
  const PROD = { orders: ord.orders || [], wd: fd.wd || [], use: fd.use || [], fabricWd: fd.fabricWd || [], caseUse: fd.caseUse || [], bagWd: fd.bagWd || [],
    bagUse: fd.bagUse || [], gasSwaps: fd.gasSwaps || [], sheetWd: fd.sheetWd || [], sheetUse: fd.sheetUse || [], feed: fd.feed || [],
    line: ln.line || [], carry: ln.carry || [], scrap: ln.scrap || [] };
  const KSET: Any = Object.assign({ sewPerPiece: 0, sewBySize: {}, laborDaily: 0, laborHoursPerDay: 8, laborPerPiece: 0, elecPerHour: 0, shipPerPack: 0, fixed: [], hoursOverride: 0 }, st || {});
  const PRICE = Object.assign({ fiber: {}, fabric: {}, zip: {}, pack: {}, gas: 0 }, pr || {});
  const COST = await loadCostCore(S);
  KSET._hoursPerMonth = +KSET.hoursOverride > 0 ? +KSET.hoursOverride : Math.max(COST.hoursPerMonth(PROD.line), r2((+KSET.laborHoursPerDay || 8) * 26));
  /* ค่าแรงรวมต่อวัน (ต่อหน้างาน ไม่ใช่รายคน) จากแอพสแกนหน้า — 40 วันล่าสุด */
  const today = bkk(new Date()).key, from = new Date(today + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 40);
  let LABOR: Any = null;
  const { data: lab, error: labErr } = await admin.rpc('att_labor_daily_svc', { p_from: from.toISOString().slice(0, 10), p_to: today });
  if (!labErr) {
    LABOR = {};
    (lab ?? []).forEach((x: Any) => { const k = String(x.day).slice(0, 10), e = LABOR[k] || (LABOR[k] = { total: 0, wage: 0, ot: 0, people: 0, units: 0, noWage: 0, noOut: 0, st: {} });
      const b = r2((+x.wage_baht || 0) + (+x.ot_baht || 0)); e.total = r2(e.total + b); e.wage = r2(e.wage + (+x.wage_baht || 0)); e.ot = r2(e.ot + (+x.ot_baht || 0));
      e.people += +x.people || 0; e.units += +x.day_units || 0; e.noWage += +x.no_wage || 0; e.noOut += +x.no_out || 0; e.st[x.station] = r2((e.st[x.station] || 0) + b); });
  }
  const ctx = { S, PROD, PRICE, LABOR, KSET, GAS: COST.gasRateFrom(PROD, PRICE) };
  return { COST, ctx, today };
}
const COST_URL_APP = 'https://production.winpolydesign.com/cost-app';
function yesterday(today: string) { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }
async function costMessage(pre?: Any, dayOverride?: string): Promise<string | null> {
  const { COST, ctx, today } = pre || await costCtx();
  const day = dayOverride || yesterday(today), c = COST.dayCost(ctx, day);
  if (!(c.total > 0) && !c.packs) return null;   /* เมื่อวานไม่มีผลิตและไม่มีค่าแรง: ไม่ส่ง */
  const kg = (ctx.PROD.line || []).filter((l: Any) => String(l.time).slice(0, 10) === day)
    .reduce((a: number, l: Any) => a + Math.max(0, ((l.actualWeight != null ? +l.actualWeight : +l.stdPerPack) || 0) - (+l.bagKgPerPack || 0)), 0);
  const rows: [string, number][] = [['🧶 ใย ' + fmtInt(c.fiberKg) + ' กก.', c.fiber], ['🧵 ผ้า+ค่าเย็บ', c.fabric], ['📦 ถุงแพ็ค', c.bagPack], ['🛍️ ถุงซิล', c.bagZip],
    ['👷 ค่าแรง (รวมเงินเดือน)', c.labor], ['🏦 ดอกเบี้ย', c.interest], ['🔥 แก๊ส', c.gas], ['⚡ ค่าไฟ', c.elec], ['🚚 ขนส่ง', c.ship]];
  return [
    '💰 ต้นทุนผลิต' + (day === yesterday(today) ? 'เมื่อวาน' : '') + ' · ' + thDate(day),
    'ผลิต ' + fmtInt(c.packs) + ' แพ็ค · ' + fmtInt(c.pieces) + ' ชิ้น' + (kg > 0 ? ' · ' + fmtInt(kg) + ' กก.' : '') + ' · เดินเครื่อง ' + c.hours + ' ชม.',
    'รวม ' + fmtBaht(c.total) + ' บาท' + (c.pieces ? ' · ' + fmtBaht(c.perPiece) + ' บาท/ชิ้น' : '') + (kg > 0 ? ' · ' + fmtBaht(r2(c.total / kg)) + ' บาท/กก.' : ''),
    ...rows.filter(([, v]) => +v > 0).map(([k, v]) => '• ' + k + ' ' + fmtBaht(v)),
    '', 'ดูละเอียด: ' + COST_URL_APP,
  ].join('\n');
}
async function alertsMessage(pre?: Any): Promise<string | null> {
  const { COST, ctx, today } = pre || await costCtx();
  const A = COST.alerts(ctx, today, { thDate: thDateShort, fmtInt, fmtBaht }).filter((x: Any) => x.lv >= 1);
  if (!A.length) return null;
  const ic = ['ℹ️', '🟡', '🔴'];
  return ['⚠️ จุดที่ควรดู (แอพต้นทุน) · ' + thDate(today), ...A.slice(0, 10).map((x: Any) => ic[x.lv] + ' ' + x.t + '\n   ' + x.d),
    A.length > 10 ? '…อีก ' + (A.length - 10) + ' เรื่อง' : '', '', 'ดูในแอพ: ' + COST_URL_APP].filter((x, i, a) => x !== '' || i === a.length - 2).join('\n');
}

/* ---------- พิมพ์ถามบอท ---------- */
const TOPIC_LABEL: Record<string, string> = { leave: 'คำขอลา', daily: 'สรุปลงเวลา', stock: 'สต๊อกใกล้หมด', cost: 'ต้นทุน', alerts: 'จุดที่ควรดู' };
const CMDS: [RegExp, string, string][] = [
  [/^(?:สต[๊็]?อก|stock)$/i, 'stock', 'สต๊อก — ของที่ใกล้หมดตอนนี้'],
  [/^(?:ต้นทุน|cost)(?:\s+(.+))?$/i, 'cost', 'ต้นทุน — ต้นทุนผลิตเมื่อวาน · ต้นทุน 15/10 — วันที่เลือก'],
  [/^(?:ลงเวลา|สรุป|เข้างาน)$/, 'daily', 'ลงเวลา — สรุปการลงเวลาวันนี้ ณ ตอนนี้'],
  [/^(?:ลา|การลา|คำขอลา)$/, 'leave', 'ลา — ใครลาวันนี้ + คำขอลาที่รออนุมัติ (กดอนุมัติได้)'],
  [/^(?:เตือน|จุดที่ควรดู|alerts?)$/i, 'alerts', 'เตือน — จุดที่ควรดูจากแอพต้นทุน'],
];
/* "15/10" "15/10/69" "15/10/2569" "2026-10-15" "วันนี้" "เมื่อวาน" → YYYY-MM-DD (ไม่ใส่ปี = ปีนี้ ถ้ายังไม่ถึงใช้ปีก่อน) */
function parseDay(arg: string, today: string): string | null {
  const a = arg.trim();
  if (!a || a === 'เมื่อวาน') return yesterday(today);
  if (a === 'วันนี้') return today;
  let key = '';
  if (/^\d{4}-\d\d-\d\d$/.test(a)) key = a;
  else {
    const m = a.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (!m) return null;
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (m[3] && y < 100) y += 2500;
    if (y > 2400) y -= 543;
    key = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!m[3] && key > today) key = `${y - 1}${key.slice(4)}`;
  }
  const d = new Date(key + 'T00:00:00Z');
  return !isNaN(+d) && d.toISOString().slice(0, 10) === key ? key : null;
}
/* ใครลาวันนี้ + คำขอที่รออนุมัติ (การ์ดมีปุ่ม สูงสุด 10 ใบ) */
async function leaveNowMessages(): Promise<unknown[]> {
  const today = bkk(new Date()).key;
  const [{ data: on }, { data: pend }] = await Promise.all([
    admin.from('att_leaves').select('emp_id, type, part').eq('status', 'approved').lte('start_date', today).gte('end_date', today),
    admin.from('att_leaves').select('id').eq('status', 'pending').order('requested_at'),
  ]);
  const ids = [...new Set((on ?? []).map((x: Any) => x.emp_id))];
  const { data: emps } = ids.length ? await admin.from('att_employees').select('id, name').in('id', ids) : { data: [] as Any[] };
  const nm = (id: string) => (emps ?? []).find((e: Any) => e.id === id)?.name ?? '(ไม่พบชื่อ)';
  const p = pend ?? [];
  const lines = [
    `🗓 ลาวันนี้ ${thDate(today)}: ${(on ?? []).length ? (on ?? []).map((x: Any) => `${nm(x.emp_id)} (${LEAVE[x.type] ?? x.type}${x.part !== 'full' ? ' ' + (PART[x.part] ?? '') : ''})`).join(', ') : 'ไม่มี'}`,
    p.length ? `📝 รออนุมัติ ${p.length} รายการ${p.length > 10 ? ' (แสดง 10 รายการแรก)' : ''}` : '✅ ไม่มีคำขอลารออนุมัติ',
  ];
  const out: unknown[] = [{ type: 'text', text: lines.join('\n') }];
  const bubbles: unknown[] = [];
  for (const x of p.slice(0, 10)) { const m = await leaveMessage(x.id); if (m) bubbles.push((m.messages[0] as Any).contents); }
  if (bubbles.length) out.push({ type: 'flex', altText: `คำขอลารออนุมัติ ${p.length} รายการ`, contents: { type: 'carousel', contents: bubbles } });
  return out;
}
async function commandReply(chatId: string, text: string): Promise<unknown[] | null> {
  const help = /^(?:เมนู|คำสั่ง|help|\?|？)$/i.test(text);
  const hit = CMDS.map((c) => ({ c, m: text.match(c[0]) })).find((x) => x.m);
  if (!help && !hit) return null;   /* คุยกันทั่วไปในกลุ่ม: ไม่ตอบ */
  const { data: t } = await admin.from('att_line_targets').select('topics').eq('line_id', chatId).maybeSingle();
  if (!t) return null;              /* แชทที่ไม่ได้เชื่อมกับระบบ: ไม่ตอบอะไรเลย */
  const can = (k: string) => !Array.isArray(t.topics) || t.topics.includes(k);
  const T = (x: string) => [{ type: 'text', text: x.slice(0, 4900) }];
  if (help || !hit) {
    const mine = CMDS.filter((c) => can(c[1]));
    return T(mine.length ? '🤖 พิมพ์ถามได้\n' + mine.map((c) => '• ' + c[2]).join('\n') : 'ห้องนี้ยังไม่ได้รับเรื่องไหน — ตั้งได้ในแอพลงเวลา → ตั้งค่า → แจ้งเตือน LINE → รับเรื่อง');
  }
  const k = hit.c[1];
  if (!can(k)) return T(`ห้องนี้ไม่ได้รับเรื่อง "${TOPIC_LABEL[k]}" — เปิดได้ในแอพลงเวลา → ตั้งค่า → แจ้งเตือน LINE → รับเรื่อง`);
  if (k === 'stock') return T((await stockMessage()) ?? '✅ ตอนนี้ไม่มีของใกล้หมด');
  if (k === 'daily') return T((await dailyMessage(true)) ?? 'วันนี้ยังไม่มีใครลงเวลา');
  if (k === 'alerts') return T((await alertsMessage()) ?? '✅ ตอนนี้ไม่มีจุดที่ควรดู');
  if (k === 'leave') return await leaveNowMessages();
  /* cost */
  const today = bkk(new Date()).key, day = parseDay(hit.m![1] ?? '', today);
  if (!day) return T('ไม่เข้าใจวันที่ — พิมพ์เช่น "ต้นทุน" (เมื่อวาน) · "ต้นทุน วันนี้" · "ต้นทุน 15/10" · "ต้นทุน 15/10/69"');
  if (day > today) return T('ยังไม่ถึงวันที่ ' + thDate(day));
  return T((await costMessage(undefined, day)) ?? `วันที่ ${thDate(day)} ไม่มีการผลิต (หรือยังไม่ได้ลงข้อมูล)`);
}

/* ---------- 1. LINE webhook ---------- */
async function handleWebhook(raw: string, signature: string) {
  const cfg = await getConfig();
  if (!cfg.channel_secret || !(await validSignature(cfg.channel_secret, raw, signature))) return fail('invalid signature', 401);
  const body = JSON.parse(raw);
  const reply = (ev: Any, text: string | unknown[]) => ev.replyToken
    ? lineApi(cfg.channel_token!, 'message/reply', { replyToken: ev.replyToken, messages: typeof text === 'string' ? [{ type: 'text', text }] : text.slice(0, 5) }).catch(console.error) : null;
  for (const ev of body.events ?? []) {
    const src = ev.source ?? {};
    const id: string | undefined = src.groupId ?? src.roomId ?? src.userId;
    const kind = src.groupId ? 'group' : src.roomId ? 'room' : 'user';
    if (!id) continue;
    if (ev.type === 'unfollow' || ev.type === 'leave') { await admin.from('att_line_targets').delete().eq('line_id', id); continue; }
    if (ev.type === 'postback') {
      const p = new URLSearchParams(String(ev.postback?.data ?? ''));
      const act = p.get('leave'), lid = p.get('id');
      if (lid && (act === 'approve' || act === 'reject')) await reply(ev, await decideFromLine(cfg, src.userId, lid, act));
      continue;
    }
    if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
    /* ตัด @ชื่อบอท ที่แท็กในกลุ่มออกก่อน */
    let said = String(ev.message.text);
    for (const x of (ev.message.mention?.mentionees ?? []).filter((x: Any) => x.isSelf).sort((a: Any, b: Any) => b.index - a.index))
      said = said.slice(0, x.index) + said.slice(x.index + x.length);
    said = said.trim().replace(/\s+/g, ' ');
    /* HR ผูก LINE ของตัวเองเพื่อกดอนุมัติลาในไลน์ได้ */
    const pm = said.match(/^ผูก\s*(\d{6})$/);
    if (pm) {
      const ok = !!src.userId && !!cfg.approver_code && pm[1] === cfg.approver_code && !!cfg.approver_code_user
        && !!cfg.approver_code_expires && new Date(cfg.approver_code_expires) > new Date();
      if (!ok) { await reply(ev, '❌ รหัสผูกไม่ถูกต้องหรือหมดอายุ กรุณากด "ผูก LINE ของฉัน" ในแอพใหม่'); continue; }
      let name = '';
      try { name = (await lineApi(cfg.channel_token!, src.groupId ? `group/${src.groupId}/member/${src.userId}` : src.roomId ? `room/${src.roomId}/member/${src.userId}` : `profile/${src.userId}`)).displayName ?? ''; }
      catch { /* the name is only for display */ }
      await admin.from('att_line_approvers').upsert({ line_user_id: src.userId, user_id: cfg.approver_code_user, name: name || null });
      await setConfig({ approver_code: null, approver_code_expires: null, approver_code_user: null });
      await reply(ev, `✅ ผูกแล้ว${name ? ' (' + name + ')' : ''} — กดปุ่ม "อนุมัติ / ไม่อนุมัติ" ในข้อความคำขอลาได้เลย`);
      continue;
    }
    const m = said.match(/^(?:เชื่อม(?:ต่อ)?|link)\s*(\d{6})$/i);
    if (!m) {
      const out = await commandReply(id, said).catch((e) => { console.error('command failed', e); return [{ type: 'text', text: '⚠️ ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง หรือดูในแอพ' }]; });
      if (out) await reply(ev, out);
      continue;
    }
    const ok = !!cfg.link_code && m[1] === cfg.link_code && !!cfg.link_code_expires && new Date(cfg.link_code_expires) > new Date();
    let msg = '❌ รหัสไม่ถูกต้องหรือหมดอายุ กรุณาสร้างรหัสใหม่ในแอป (ตั้งค่า → แจ้งเตือน LINE)';
    if (ok) {
      let label = kind === 'user' ? 'แชทส่วนตัว' : 'กลุ่ม';
      try {
        if (kind === 'user') label = (await lineApi(cfg.channel_token!, `profile/${id}`)).displayName ?? label;
        if (kind === 'group') label = (await lineApi(cfg.channel_token!, `group/${id}/summary`)).groupName ?? label;
      } catch { /* the name is only for display */ }
      await admin.from('att_line_targets').upsert({ line_id: id, kind, name: label });
      await setConfig({ link_code: null, link_code_expires: null });
      msg = `✅ เชื่อมต่อสำเร็จ ${kind === 'user' ? 'แชทนี้' : 'กลุ่มนี้'}จะได้รับแจ้งเตือน: คำขอลา · สรุปลงเวลา 21:00 · สต๊อกใกล้หมด 08:00 (เลือกเรื่องที่รับได้ในแอพ ตั้งค่า → แจ้งเตือน LINE) · พิมพ์ "เมนู" เพื่อดูว่าถามบอทอะไรได้บ้าง`;
    }
    await reply(ev, msg);
  }
  return json({ ok: true });
}

/* ---------- 2. database ---------- */
async function handleInternal(secret: string, body: Record<string, unknown>) {
  const cfg = await getConfig();
  if (secret !== cfg.internal_secret) return fail('forbidden', 403);
  if (!cfg.channel_token) return json({ skipped: 'not configured' });
  /* ตรวจข้อความโดยไม่ส่ง (ใช้ทดสอบหลังแก้โค้ด) */
  if (body.type === 'dry') {
    const pre = await costCtx();
    const d = /^\d{4}-\d\d-\d\d$/.test(String(body.day || '')) ? String(body.day) : undefined;
    /* leave: ให้ LINE ตรวจรูปแบบปุ่มของคำขอลาจริง (ไม่ส่ง) */
    let leave: unknown = undefined;
    if (body.leave) {
      const m = await leaveMessage(String(body.leave), true);
      leave = !m ? 'not found' : await lineApi(cfg.channel_token!, 'message/validate/push', { messages: m.messages }).then(() => 'valid', (e) => String(e));
    }
    return json({ stock: await stockMessage(), cost: await costMessage(pre, d), alerts: await alertsMessage(pre), leave });
  }
  if (body.type === 'morning') {
    const out: Record<string, unknown> = {};
    if (cfg.notify_stock) { const t = await stockMessage(); out.stock = t ? await pushAll(cfg, t, 'stock') : 'none'; }
    if (cfg.notify_cost || cfg.notify_alerts) {
      const pre = await costCtx();
      if (cfg.notify_cost) { const t = await costMessage(pre); out.cost = t ? await pushAll(cfg, t, 'cost') : 'none'; }
      if (cfg.notify_alerts) {
        const t = await alertsMessage(pre), key = t ? t.split('\n').slice(1).join('\n') : '';
        /* ส่งเฉพาะตอนรายการเปลี่ยน — เรื่องเดิมค้างไม่ต้องเตือนซ้ำทุกเช้า */
        if (t && key !== (cfg.last_alerts || '')) { out.alerts = await pushAll(cfg, t, 'alerts'); await setConfig({ last_alerts: key }); }
        else { out.alerts = t ? 'unchanged' : 'none'; if (!t && cfg.last_alerts) await setConfig({ last_alerts: null }); }
      }
    }
    return json(out);
  }
  let text: string | null = null, topic = '';
  if (body.type === 'leave' && cfg.notify_leave) {
    const m = await leaveMessage(String(body.id));
    return json(m ? { sent: await pushAll(cfg, m.text, 'leave', m.messages) } : { skipped: true });
  }
  if (body.type === 'daily' && cfg.notify_daily) { text = await dailyMessage(); topic = 'daily'; }
  if (body.type === 'stock' && cfg.notify_stock) { text = await stockMessage(); topic = 'stock'; }
  if (!text) return json({ skipped: true });
  return json({ sent: await pushAll(cfg, text, topic) });
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
      const { data: targets } = await admin.from('att_line_targets').select('line_id, kind, name, created_at, topics').order('created_at');
      const codeLive = cfg.link_code && cfg.link_code_expires && new Date(cfg.link_code_expires) > new Date();
      const { data: approvers } = await admin.from('att_line_approvers').select('line_user_id, user_id, name, created_at').order('created_at');
      const apLive = cfg.approver_code && cfg.approver_code_user === user.id && cfg.approver_code_expires && new Date(cfg.approver_code_expires) > new Date();
      return json({
        configured: !!cfg.channel_token, botName: cfg.bot_name, basicId: cfg.bot_basic_id, webhookUrl: WEBHOOK_URL,
        notifyLeave: cfg.notify_leave, notifyDaily: cfg.notify_daily, notifyStock: cfg.notify_stock, notifyCost: cfg.notify_cost, notifyAlerts: cfg.notify_alerts, targets: targets ?? [],
        code: codeLive ? cfg.link_code : null, codeExpires: codeLive ? cfg.link_code_expires : null,
        approvers: (approvers ?? []).map((a) => ({ line_user_id: a.line_user_id, name: a.name, created_at: a.created_at, mine: a.user_id === user.id })),
        approverCode: apLive ? cfg.approver_code : null, approverCodeExpires: apLive ? cfg.approver_code_expires : null,
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
    case 'approver-code': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const expires = new Date(Date.now() + 15 * 60000).toISOString();
      await setConfig({ approver_code: code, approver_code_expires: expires, approver_code_user: user.id });
      return json({ code, expires });
    }
    case 'approver-remove': {
      await admin.from('att_line_approvers').delete().eq('line_user_id', String(body.line_user_id ?? ''));
      return json({ ok: true });
    }
    case 'options': {
      await setConfig({ notify_leave: !!body.notifyLeave, notify_daily: !!body.notifyDaily, ...(body.notifyStock === undefined ? {} : { notify_stock: !!body.notifyStock }),
        ...(body.notifyCost === undefined ? {} : { notify_cost: !!body.notifyCost }), ...(body.notifyAlerts === undefined ? {} : { notify_alerts: !!body.notifyAlerts }) });
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
      return json({ sent: text ? await pushAll(cfg, text, 'daily') : 0, empty: !text });
    }
    case 'topics': {
      const topics = (Array.isArray(body.topics) ? body.topics : []).map(String).filter((x) => TOPICS.includes(x));
      await admin.from('att_line_targets').update({ topics }).eq('line_id', String(body.line_id ?? ''));
      return json({ ok: true, topics });
    }
    case 'preview': {
      const k = String(body.kind || '');
      const text = k === 'stock' ? await stockMessage() : k === 'cost' ? await costMessage() : k === 'alerts' ? await alertsMessage() : k === 'daily' ? await dailyMessage() : null;
      return json({ text });
    }
    case 'send-now': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const k = String(body.kind || '');
      const text = k === 'stock' ? await stockMessage() : k === 'cost' ? await costMessage() : k === 'alerts' ? await alertsMessage() : k === 'daily' ? await dailyMessage() : null;
      return json({ sent: text ? await pushAll(cfg, text, k) : 0, empty: !text });
    }
    case 'stock-preview': {
      return json({ text: await stockMessage() });
    }
    case 'stock-now': {
      if (!cfg.channel_token) return fail('ยังไม่ได้ตั้งค่าบอท LINE');
      const text = await stockMessage();
      return json({ sent: text ? await pushAll(cfg, text, 'stock') : 0, empty: !text });
    }
    case 'disconnect': {
      await admin.from('att_line_targets').delete().neq('line_id', '');
      await admin.from('att_line_approvers').delete().neq('line_user_id', '');
      await setConfig({ channel_secret: null, channel_token: null, bot_name: null, bot_basic_id: null, link_code: null, link_code_expires: null,
        approver_code: null, approver_code_expires: null, approver_code_user: null });
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
