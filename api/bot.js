// Chatbot de WhatsApp para AutoResponder.ai (webhook).
// AutoResponder envía cada mensaje aquí; respondemos con OpenAI usando el menú real del POS
// y, cuando el cliente confirma, creamos el pedido en Firestore (llega al POS como los demás pedidos online).
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

function systemPrompt(cfg, items, phone) {
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

# FORMATO DE RESPUESTA (obligatorio)
Responde SIEMPRE con un único objeto JSON, sin texto fuera de él:
{"reply": "mensaje para el cliente", "order": null}
- "reply" sigue todas las reglas de conversación y estilo anteriores (breve, una pregunta por mensaje).
- "order" es null en todos los mensajes, EXCEPTO en el mensaje en que el cliente CONFIRMA el resumen final (dice sí, confirmo, dale, etc.). En ese mensaje "reply" debe ser solo "Pedido confirmado." y "order" lleva:
{"tipo":"domicilio"|"recoger","nombre":"","telefono":"","direccion":"","barrio":"(exacto de la lista)","pago":"(uno de los medios de pago)","pago_domicilio":"recibir"|"incluido"|"","nota":"","lineas":[{"id":<id del catálogo>,"qty":1,"opciones":["nombres de opciones del catálogo"],"nota":"cambios libres, p. ej. sin cebolla","unidades_con_cambio":<opcional>}]}
- Los cambios como "sin cebolla" van en "opciones" si coinciden con una opción del catálogo; si no, en la "nota" de la línea.
- "qty" es el total de unidades de ese producto. "opciones"/"nota" son el cambio. Si el cambio aplica solo a ALGUNAS unidades, pon en "unidades_con_cambio" cuántas lo llevan (ej.: 3 perros y 1 sin cebolla → qty 3, opciones ["Sin cebolla"], unidades_con_cambio 1). Si aplica a todas, omite "unidades_con_cambio". Si cada unidad lleva un cambio distinto, usa una línea por cada cambio.
- No incluyas "order" antes de que el cliente confirme.`;
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
function buildOrder(o, cfg, items, phoneKnown, sender) {
  const zones = (cfg.zones || []).filter(z => z.n);
  const dom = norm(o.tipo).startsWith('dom');
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
  if (dom) {
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
  const note = ['💬 WhatsApp', clean(o.nota, 200), !dom ? 'Pago: ' + pagoBase : '', flags.length ? '⚠ REVISAR: ' + flags.join('; ') : ''].filter(Boolean).join(' | ').slice(0, 300);
  return {
    type: dom ? 'domicilio' : 'mesa', table: (dom ? zone : PICK).slice(0, 40),
    name: clean(o.nombre || sender, 80), phone: phone.slice(0, 30), address: dom ? clean(o.direccion, 200) : '',
    note, pay: payTxt.slice(0, 40), fee, lines, total: sub + fee, status: 'new', source: 'whatsapp',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
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
    let msgs = [];
    if (snap.exists) { const d = snap.data(); if (Date.now() - (d.at || 0) < 8 * 3600e3) msgs = Array.isArray(d.msgs) ? d.msgs : []; }

    const raw = await openai([{ role: 'system', content: systemPrompt(cfg, items, phoneKnown) },
      ...msgs.map(m => ({ role: m.r === 'u' ? 'user' : 'assistant', content: m.t })), { role: 'user', content: text }]);
    const { reply, order } = parseModel(raw);
    let out = reply || 'Un momento, por favor.';
    let orderId = null;

    if (order && cfg.open === false) out = 'Por ahora estamos cerrados. Nuestro horario es de 5 pm a 10 pm. ¡Te esperamos!';
    else if (order) {
      const doc = buildOrder(order, cfg, items, phoneKnown, sender);
      if (!doc.lines.length) out = 'Disculpa, no pude registrar el pedido. Una persona del equipo te ayuda enseguida.';
      else {
        const r = await db.collection('orders').add(doc);
        orderId = r.id;
        try { // aviso push a los equipos (igual que el menú web)
          await fetch('https://' + req.headers.host + '/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: orderId }), signal: AbortSignal.timeout(4000) });
        } catch (e) {}
      }
    }
    const hist = orderId ? [] : msgs.concat([{ r: 'u', t: text }, { r: 'a', t: out }]).slice(-24);
    await ref.set({ msgs: hist, at: Date.now(), lastOrder: orderId || (snap.exists ? snap.data().lastOrder || null : null) });
    return res.status(200).json({ replies: [{ message: out }] });
  } catch (e) {
    console.error('bot', e && e.message);
    return res.status(200).json({ replies: [{ message: 'Disculpa, tuve un problema. Un momento, ya te ayuda una persona del equipo.' }] });
  }
};
