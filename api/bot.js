// Chatbot de WhatsApp para AutoResponder.ai (webhook).
// AutoResponder envía cada mensaje aquí; respondemos con OpenAI usando el menú real del POS
// y, cuando el cliente entrega los datos finales, creamos el pedido en Firestore (llega al POS como los demás pedidos online).
//
// Variables en Vercel: OPENAI_API_KEY, BOT_SECRET, FIREBASE_SERVICE_ACCOUNT  (opcional: OPENAI_MODEL)
// URL para AutoResponder:  https://TU-DOMINIO.vercel.app/api/bot?k=TU_BOT_SECRET
const admin = require('firebase-admin');
const crypto = require('crypto');
const BASE_PROMPT = require('./_bot_prompt');

function getDb() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return admin.firestore();
}
const PICK = 'Para recoger';
const money = n => '$' + Math.round(+n || 0).toLocaleString('es-CO');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

let cache = { at: 0, cfg: null, items: [] };
async function loadMenu(db) {
  if (Date.now() - cache.at < 45000 && cache.cfg) return cache;
  const [c, it] = await Promise.all([db.collection('menu').doc('config').get(), db.collection('menu_items').get()]);
  cache = { at: Date.now(), cfg: c.exists ? c.data() : {}, items: it.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0)) };
  return cache;
}
const groupsOf = (it, mods) => (it.mods || []).map(id => (mods || []).find(m => String(m.id) === String(id))).filter(Boolean);

function catalogText(cfg, items) {
  return items.map(it => {
    const off = it.stock != null && +it.stock <= 0;
    const g = groupsOf(it, cfg.mods).map(m => `${m.name}: ${(m.opts || []).map(o => o.n + (+o.p ? ' (+' + money(o.p) + ')' : '')).join(' / ')}`).join(' ; ');
    return `[${it.id}] ${it.name} — ${money(it.price)} — ${it.cat || ''}${off ? ' — AGOTADO' : ''}${g ? ' — opciones: ' + g : ''}`;
  }).join('\n');
}

function systemPrompt(cfg, items, phone, base) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const zones = (cfg.zones || []).filter(z => z.n);
  return `${BASE_PROMPT}

# DATOS EN VIVO DEL SISTEMA (tienen prioridad sobre lo anterior si hay diferencias)
Hoy es ${dias[now.getDay()]}, hora ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} (Colombia).
${cfg.open === false ? 'El negocio está CERRADO para pedidos ahora mismo: avisa amablemente y no tomes pedidos.' : ''}
Teléfono del cliente: ${phone || 'NO CONOCIDO (pídelo si es domicilio o recoger)'}.

## Catálogo oficial (usa SOLO estos id y precios al registrar el pedido)
${catalogText(cfg, items)}

## Barrios con domicilio y su tarifa (reemplazan las tarifas de la sección 5)
${zones.map(z => `${z.n}: ${money(z.p)}`).join('\n') || '(sin tarifas configuradas)'}
Si el barrio no está en esta lista, di que una persona del equipo confirma cobertura y tarifa.

## Medios de pago del sistema
${(cfg.pays || []).join(', ') || 'Efectivo, Transferencia'}
${cfg.trInfo ? 'Datos para transferir:\n' + cfg.trInfo : ''}

${base ? `# PEDIDO ANTERIOR DE ESTE CLIENTE (ya confirmado en esta conversación)
Cliente: ${base.name}${base.tipo === 'domicilio' ? ' (domicilio)' : ' (recoger)'}.
Productos (con su id del catálogo): ${base.lines && base.lines.length ? base.lines.map(l => `[${l.id}] ${l.name} x${l.qty}`).join(', ') : base.summary}
Estado: ${base.open ? 'EN PREPARACIÓN (todavía se puede agregar o cambiar algo)' : 'YA NO SE PUEDE MODIFICAR (está listo, ya salió o se cerró)'}.
La conversación sigue abierta. Reglas para mensajes posteriores:
- Si el cliente quiere AGREGAR algo y el pedido está en preparación: toma solo lo nuevo (con la misma regla de no repetir lo ya pedido), ofrécele lo que falte (bebida, adicionales) solo si es útil, y al final muestra un resumen corto SOLO de lo agregado y pide confirmación. Cuando confirme, responde «Listo, lo agregué a tu pedido.» y envía "order" con "tipo":"adicion" y solo las líneas nuevas (no pidas nombre, teléfono, dirección ni pago otra vez: ya los tienes).
- Si quiere CAMBIAR o QUITAR algo del pedido anterior y está en preparación: confirma el cambio con una frase corta y envía "order" con "tipo":"cambio" y en "nota" la descripción exacta del cambio (con el nombre del producto afectado). Responde «Listo, avisamos a cocina del cambio.»
- Si el pedido ya no se puede modificar: explica amablemente que ya salió o está listo y ofrécele hacer un pedido nuevo (se pide todo como un pedido nuevo, con "tipo":"domicilio" o "recoger", incluyendo solo lo del pedido nuevo).
- Si el cliente quiere un pedido totalmente distinto, tómalo como pedido nuevo.
- MUY IMPORTANTE: en "order" con "tipo":"adicion" incluye ÚNICAMENTE los productos nuevos. NUNCA repitas los productos del pedido anterior ni cambies su id. Al resumir una adición, muestra solo lo agregado y su valor, no el total de todo el pedido.
` : ''}
# REGLA DE TELÉFONO
Si el teléfono del cliente figura como NO CONOCIDO, debes pedírselo (para domicilio o para recoger) ANTES de mostrar el resumen final. No confirmes un pedido sin teléfono.

# FORMATO DE RESPUESTA (obligatorio)
Responde SIEMPRE con un único objeto JSON, sin texto fuera de él:
{"reply": "mensaje para el cliente", "order": null}
- "reply" sigue todas las reglas de conversación y estilo anteriores (breve, una pregunta por mensaje).
- "order" es null en todos los mensajes, EXCEPTO en el mensaje en que el cliente entrega los últimos datos que faltan para un pedido NUEVO (nombre, teléfono, dirección y barrio si es domicilio, y medio de pago). Ya NO hay paso de confirmación: en ese mismo mensaje registras el pedido, y "reply" lleva el primer mensaje de pago (si es transferencia) y el resumen final, separados por la marca [[CORTE]] exactamente como indican las reglas de conversación. Para adiciones y cambios sobre un pedido anterior se sigue lo indicado en el bloque PEDIDO ANTERIOR. En ese mensaje "order" lleva:
{"tipo":"domicilio"|"recoger"|"adicion"|"cambio","nombre":"","telefono":"","direccion":"","barrio":"(exacto de la lista)","pago":"(uno de los medios de pago)","pago_domicilio":"recibir"|"incluido"|"","nota":"","lineas":[{"id":<id del catálogo>,"qty":1,"opciones":["nombres de opciones del catálogo"],"nota":"cambios libres, p. ej. sin cebolla","unidades_con_cambio":<opcional>}]}
- Los cambios como "sin cebolla" van en "opciones" si coinciden con una opción del catálogo; si no, en la "nota" de la línea.
- "qty" es el total de unidades de ese producto. "opciones"/"nota" son el cambio. Si el cambio aplica solo a ALGUNAS unidades, pon en "unidades_con_cambio" cuántas lo llevan (ej.: 3 perros y 1 sin cebolla → qty 3, opciones ["Sin cebolla"], unidades_con_cambio 1). Si aplica a todas, omite "unidades_con_cambio". Si cada unidad lleva un cambio distinto, usa una línea por cada cambio.
- No incluyas "order" antes de tener todos los datos del pedido nuevo.`;
}

async function openai(messages) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 24000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages, temperature: 0.3, response_format: { type: 'json_object' } })
    });
    if (!r.ok) throw new Error('openai ' + r.status);
    const j = await r.json();
    return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  } finally { clearTimeout(to); }
}

function parseModel(raw) {
  try { const j = JSON.parse(raw); return { reply: clean(j.reply, 1500), order: j.order && typeof j.order === 'object' ? j.order : null }; }
  catch (e) { return { reply: clean(String(raw).replace(/[{}"]/g, ''), 600), order: null }; }
}

// Convierte la orden del modelo en un pedido válido para el POS. Nunca se pierde un pedido: lo dudoso queda marcado para revisar.
function buildOrder(o, cfg, items, phoneKnown, sender, add) {
  const zones = (cfg.zones || []).filter(z => z.n);
  const dom = norm(o.tipo).startsWith('dom') || (add && add.tipo === 'domicilio');
  const flags = [];
  const lines = [];
  (Array.isArray(o.lineas) ? o.lineas : []).slice(0, 40).forEach(l => {
    const qty = Math.max(1, Math.min(50, Math.floor(+l.qty) || 1));
    let it = items.find(i => String(i.id) === String(l.id));
    const optsAsked = (Array.isArray(l.opciones) ? l.opciones : []).map(x => clean(x, 60)).filter(Boolean);
    if (!it) { flags.push('producto no reconocido'); lines.push({ id: 'x' + clean(l.id, 20), name: '⚠ REVISAR: ' + clean(l.nota || l.id, 80), qty, price: 0, mods: [], cat: '' }); return; }
    const valid = groupsOf(it, cfg.mods).flatMap(m => m.opts || []);
    const mods = []; let price = +it.price || 0; const extra = [];
    optsAsked.forEach(n => { const op = valid.find(v => norm(v.n) === norm(n)); if (op) { if (!mods.includes(op.n)) { mods.push(op.n); price += +op.p || 0; } } else extra.push(n); });
    const free = [clean(l.nota, 80), ...extra].filter(Boolean).join(', ');
    if (free) mods.push(free.slice(0, 80));
    const nCh = Math.floor(+l.unidades_con_cambio);
    if (mods.length && nCh >= 1 && nCh < qty) { // el cambio aplica solo a algunas unidades: separar en dos líneas
      lines.push({ id: it.id, name: it.name, qty: nCh, price, mods, cat: it.cat || '' });
      lines.push({ id: it.id, name: it.name, qty: qty - nCh, price: +it.price || 0, mods: [], cat: it.cat || '' });
    } else lines.push({ id: it.id, name: it.name, qty, price, mods, cat: it.cat || '' });
  });
  if (!lines.length) flags.push('sin productos');
  let zone = '', fee = 0;
  if (dom && !add) {
    const z = zones.find(x => norm(x.n) === norm(o.barrio)) || zones.find(x => norm(o.barrio) && norm(x.n).includes(norm(o.barrio)));
    if (z) { zone = z.n; fee = +z.p || 0; } else flags.push('barrio sin tarifa: ' + clean(o.barrio, 40));
    if (!clean(o.direccion, 200)) flags.push('sin dirección');
  }
  const digits = String(o.telefono || '').replace(/\D/g, '');
  const phone = digits.length >= 7 ? digits.slice(-10) : (phoneKnown || '');
  if (!phone) flags.push('sin teléfono');
  const pagoBase = clean(o.pago, 30) || ((cfg.pays || [])[0] || '');
  const tr = /transfer|nequi|bre|davi/i.test(pagoBase);
  const payTxt = dom ? (tr && o.pago_domicilio ? pagoBase + (o.pago_domicilio === 'recibir' ? ' · domicilio al recibir' : ' · domicilio incluido') : pagoBase) : '';
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const note = [add ? '➕ ADICIÓN al pedido anterior (mismo cliente, sin cobrar domicilio otra vez)' : '', '💬 WhatsApp', clean(add ? '' : o.nota, 200), !dom && !add ? 'Pago: ' + pagoBase : '', flags.length ? '⚠ REVISAR: ' + flags.join('; ') : ''].filter(Boolean).join(' | ').slice(0, 300);
  return {
    type: dom ? 'domicilio' : 'mesa', table: (add ? (dom ? '' : PICK) : (dom ? zone : PICK)).slice(0, 40),
    name: clean((o.nombre || sender) + (add ? ' (adición)' : ''), 80), phone: phone.slice(0, 30), address: dom ? clean(o.direccion, 200) : '',
    note, pay: payTxt.slice(0, 40), fee, lines, total: sub + fee, status: 'new', source: 'whatsapp',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function subtractLines(lineas, bl) {
  const have = {}; bl.forEach(l => { have[l.id] = (have[l.id] || 0) + l.qty; });
  return lineas.map(l => { const q = Math.max(1, Math.floor(+l.qty) || 1), h = have[l.id] || 0, use = Math.min(h, q); have[l.id] = h - use; return use >= q ? null : Object.assign({}, l, { qty: q - use, unidades_con_cambio: undefined }); }).filter(Boolean);
}
function isReemit(lineas, bl) {
  if (!bl.length) return false;
  return bl.every(b => lineas.filter(l => String(l.id) === String(b.id)).reduce((s2, l) => s2 + (Math.floor(+l.qty) || 1), 0) >= b.qty);
}
function mergeLines(a, b) {
  const m = {}; a.concat(b).forEach(l => { m[l.id] = m[l.id] ? Object.assign({}, m[l.id], { qty: m[l.id].qty + l.qty }) : Object.assign({}, l); });
  return Object.values(m);
}

function buildChange(o, base, sender) {
  const txt = clean(o.nota || (Array.isArray(o.lineas) && o.lineas[0] && o.lineas[0].nota) || 'cambio solicitado', 150);
  const dom = base.tipo === 'domicilio';
  return {
    type: dom ? 'domicilio' : 'mesa', table: dom ? '' : PICK, name: clean((base.name || sender) + ' (cambio)', 80), phone: clean(base.phone, 30), address: dom ? clean(base.address, 200) : '',
    note: '✏️ CAMBIO AL PEDIDO ANTERIOR | 💬 WhatsApp', pay: '', fee: 0,
    lines: [{ id: 'cambio', name: '⚠ CAMBIO: ' + txt, qty: 1, price: 0, mods: [], cat: '' }],
    total: 0, status: 'new', source: 'whatsapp', createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

// ---- horario de atención (hora de Colombia) ----
const DN = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const hm = t => { const [h, m] = String(t || '0:0').split(':'); return (+h || 0) * 60 + (+m || 0); };
const t12 = t => { const x = hm(t), h = Math.floor(x / 60) % 24, m = x % 60; return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'a. m.' : 'p. m.'); };
function nowCO() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { d: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), m: (+p.hour) * 60 + (+p.minute) };
}
function hrOn(cfg) { return !!(cfg && cfg.hr && cfg.hr.on && Array.isArray(cfg.hr.d)); }
function inHours(cfg) {
  if (!hrOn(cfg)) return true;
  const hr = cfg.hr, n = nowCO(), c = hr.d[n.d], p = hr.d[(n.d + 6) % 7];
  if (c && c.o) { const a = hm(c.a), z = hm(c.c); if (a === z || (a < z ? (n.m >= a && n.m < z) : n.m >= a)) return true; }
  if (p && p.o) { const a = hm(p.a), z = hm(p.c); if (a > z && n.m < z) return true; }
  return false;
}
function scheduleText(cfg) {
  if (!hrOn(cfg)) return '';
  const lab = i => { const d = cfg.hr.d[i] || {}; return d.o ? t12(d.a) + ' – ' + t12(d.c) : 'Cerrado'; };
  const order = [1, 2, 3, 4, 5, 6, 0], runs = [];
  order.forEach(i => { const l = lab(i), last = runs[runs.length - 1]; if (last && last.l === l) last.e = i; else runs.push({ s: i, e: i, l }); });
  return runs.map(r => (r.s === r.e ? DN[r.s] : DN[r.s] + ' a ' + DN[r.e]) + ': ' + r.l).join('\n');
}
function closedText(cfg) {
  const sch = scheduleText(cfg), byHours = !inHours(cfg);
  return '¡Hola!' + (byHours ? 'Por ahora estamos *CERRADOS* 🔒.' : 'Hoy no estamos recibiendo pedidos por este medio.') +
    (sch ? '\n\n🕒 *Horario de atención:*\n' + sch + '\n\nEscríbenos en ese horario y con gusto te atendemos 😊' : '') +
    (cfg.closedMsg ? '\n\n' + String(cfg.closedMsg).slice(0, 300) : '');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  const secret = process.env.BOT_SECRET;
  if (!secret || !process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'servidor sin configurar' });
  const given = String((req.headers && (req.headers['x-secret'] || '')) || (req.query && req.query.k) || '');
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return res.status(401).json({ error: 'clave' });

  const q = (req.body && req.body.query) || null;
  if (!q || typeof q.message !== 'string' || !q.sender) return res.status(400).json({ error: 'mensaje inválido' });
  if (q.isGroup === true || q.isGroup === 'true') return res.status(200).json({ replies: [] });
  const text = clean(q.message, 800), sender = clean(q.sender, 60);
  if (!text) return res.status(200).json({ replies: [] });

  try {
    const db = getDb();
    const { cfg, items } = await loadMenu(db);
    const digits = sender.replace(/\D/g, '');
    const phoneKnown = digits.length >= 10 && digits.length === sender.replace(/[\s+\-()]/g, '').length ? digits.slice(-10) : '';
    const key = crypto.createHash('sha1').update(sender).digest('hex').slice(0, 24);
    const ref = db.collection('bot_chats').doc(key);
    const snap = await ref.get();
    let msgs = [], base = null;
    const prev = snap.exists ? snap.data() : {};
    if (snap.exists && Date.now() - (prev.at || 0) < 8 * 3600e3) {
      msgs = Array.isArray(prev.msgs) ? prev.msgs : [];
      if (prev.lastOrder && prev.lastInfo) {
        let st = '', sum = '';
        try { const bs = await db.collection('orders').doc(prev.lastOrder).get(); if (bs.exists) { const b = bs.data(); st = b.status; sum = (b.lines || []).map(l => l.qty + ' ' + l.name + ((l.mods || []).length ? ' (' + l.mods.join(', ') + ')' : '')).join(', '); } } catch (e) {}
        base = Object.assign({}, prev.lastInfo, { lines: Array.isArray(prev.lastInfo.lines) ? prev.lastInfo.lines : [], summary: sum || '(sin detalle)', open: (st === 'new' || st === 'received') && Date.now() - (prev.lastAt || 0) < 3 * 3600e3 });
      }
    }

    // Fuera de horario (o cerrado a mano): responder CERRADO sin gastar IA, salvo que el cliente ya tenga un pedido abierto
    if ((cfg.open === false || !inHours(cfg)) && !(base && base.open)) return res.status(200).json({ replies: [{ message: closedText(cfg), delay: 1 }] });

    const raw = await openai([{ role: 'system', content: systemPrompt(cfg, items, phoneKnown, base) },
      ...msgs.map(m => ({ role: m.r === 'u' ? 'user' : 'assistant', content: m.t })), { role: 'user', content: text }]);
    let { reply, order } = parseModel(raw);
    let out = reply || 'Un momento, por favor.';
    let orderId = null;

    let info = null, addInfo = null;
    if (order && cfg.open === false) out = closedText(cfg);
    else if (order) {
      let kind = norm(order.tipo), warn = false;
      const bl = base ? base.lines : [];
      const lin = Array.isArray(order.lineas) ? order.lineas : [];
      if (base && base.open && kind !== 'cambio') {
        const ids = new Set(bl.map(l => String(l.id)));
        const full = kind === 'domicilio' || kind === 'recoger';
        if ((kind === 'adicion' && isReemit(lin, bl)) || (full && lin.some(l => ids.has(String(l.id))))) { // el modelo repitió el pedido anterior: se deja solo lo nuevo
          order = Object.assign({}, order, { tipo: 'adicion', lineas: subtractLines(lin, bl) }); kind = 'adicion'; warn = true;
          if (!order.lineas.length) { out = 'Ya lo tengo anotado en tu pedido. ¿Necesitas algo más?'; kind = 'skip'; }
        }
      }
      let doc = null;
      if (kind === 'skip') doc = null;
      else if (kind === 'cambio' && base && base.open) { doc = buildChange(order, base, sender); doc.addTo = prev.lastOrder; doc.kind = 'cambio'; }
      else if (kind === 'adicion' && base && base.open) { doc = buildOrder(Object.assign({}, order, { tipo: base.tipo, nombre: base.name, direccion: base.address, pago: base.pago, telefono: base.phone }), cfg, items, base.phone || phoneKnown, sender, base); doc.addTo = prev.lastOrder; doc.kind = 'adicion'; if (warn) doc.note += ' | ⚠ REVISAR: confirmar que sean solo productos nuevos'; }
      else if ((kind === 'adicion' || kind === 'cambio') && base) { // el pedido anterior ya no se puede tocar: se registra como pedido nuevo con los mismos datos
        doc = kind === 'cambio' ? null : buildOrder(Object.assign({}, order, { tipo: base.tipo, nombre: base.name, telefono: base.phone, direccion: base.address, barrio: base.zone, pago: base.pago }), cfg, items, base.phone || phoneKnown, sender);
        if (!doc) out = 'Ese pedido ya salió o está listo, por eso no puedo cambiarlo. Una persona del equipo te ayuda enseguida.';
      } else doc = buildOrder(order, cfg, items, phoneKnown, sender);
      if (doc) {
        if (!doc.lines.length) out = 'Disculpa, no pude registrar el pedido. Una persona del equipo te ayuda enseguida.';
        else {
          const r = await db.collection('orders').add(doc);
          orderId = r.id;
          const real = doc.lines.filter(l => !String(l.id).startsWith('x') && l.id !== 'cambio').map(l => ({ id: l.id, name: l.name, qty: l.qty }));
          if (doc.addTo && doc.kind === 'adicion') addInfo = Object.assign({}, prev.lastInfo, { lines: mergeLines(bl, real) });
          else if (doc.kind !== 'cambio') info = { tipo: doc.type === 'domicilio' ? 'domicilio' : 'recoger', name: doc.name, phone: doc.phone, address: doc.address, zone: doc.table === PICK ? '' : doc.table, pago: clean(order.pago, 30), lines: real };
          try { // aviso push a los equipos (igual que el menú web)
            await fetch('https://' + req.headers.host + '/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: orderId }), signal: AbortSignal.timeout(4000) });
          } catch (e) {}
        }
      }
    }
    const parts = String(out).split(/\s*\[\[CORTE\]\]\s*/).map(x => x.trim()).filter(Boolean);
    out = parts.join('\n\n') || out;
    const hist = msgs.concat([{ r: 'u', t: text }, { r: 'a', t: out }]).slice(-30);
    const save = { msgs: hist, at: Date.now(), lastOrder: prev.lastOrder || null, lastInfo: prev.lastInfo || null, lastAt: prev.lastAt || 0 };
    if (info) { save.lastOrder = orderId; save.lastInfo = info; save.lastAt = Date.now(); }
    else if (addInfo) save.lastInfo = addInfo;
    await ref.set(save);
    return res.status(200).json({ replies: (parts.length ? parts : [out]).map((m, i) => i ? { message: m, delay: 2 } : { message: m }) });
  } catch (e) {
    console.error('bot', e && e.message);
    return res.status(200).json({ replies: [{ message: 'Disculpa, tuve un problema. Un momento, ya te ayuda una persona del equipo.' }] });
  }
};
