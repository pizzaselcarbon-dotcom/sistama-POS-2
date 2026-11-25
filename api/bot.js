// Chatbot de WhatsApp para AutoResponder.ai (webhook).
// AutoResponder envía cada mensaje aquí; respondemos con OpenAI usando el menú real del POS
// y, cuando el cliente confirma, creamos el pedido en Firestore (llega al POS como los demás pedidos online).
//
// Variables en Vercel: OPENAI_API_KEY, BOT_SECRET, FIREBASE_SERVICE_ACCOUNT  (opcional: OPENAI_MODEL)
// URL para AutoResponder:  https://TU-DOMINIO.vercel.app/api/bot?k=TU_BOT_SECRET
const admin = require('firebase-admin');
const crypto = require('crypto');
const BASE_PROMPT = require('./_bot_prompt');

const STATUS_Q = /(cu[aá]nto\s+(se\s+)?(demora|falta|tarda|van|llega)|se\s+demor|demor[ao]n?|tard[ao]n?|ya\s+(viene|sali[oó]|va|llega|est[aá])|d[oó]nde\s+(est[aá]|va|viene)|qu[eé]\s+(pas[oó]|hay)\s+con\s+(mi|el)\s+pedido|c[oó]mo\s+va\s+(mi|el)\s+pedido|mi\s+pedido\s*\?|estado\s+(de\s+)?(mi|del)\s+pedido)/i;
const ORDER_WORDS = /(quiero|agrega|a[ñn]ade|cambia|quita|cancela|pedir|me\s+(das|regalas|env[ií]as)\s+\d)/i;
// Copia de la conversación para que el POS la muestre (colección pos_*, solo legible con sesión del dueño)
async function mirrorChat(db, key, sender, phone, q, add, lastOrder) {
  try {
    const ref = db.collection('pos_wachats').doc(key);
    const ex = await ref.get();
    const old = ex.exists && ex.data() && Array.isArray(ex.data().msgs) ? ex.data().msgs : [];
    const nm = clean(q.name || q.senderName || q.pushname || '', 60) || (ex.exists && ex.data().name) || '';
    const msgs = old.concat(add.map(m => ({ r: m.r, t: String(m.t).slice(0, 1500) }))).slice(-60);
    await ref.set({ sender: clean(sender, 60), phone: phone || (ex.exists && ex.data().phone) || '', name: nm, msgs, at: Date.now(), lastOrder: lastOrder || (ex.exists && ex.data().lastOrder) || '' });
  } catch (e) { console.error('mirror', e && e.message); }
}
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

// La porción de papa solo se ofrece con perros calientes y hamburguesas (el modelo a veces la ofrece con todo)
const BASE_PAPA = /hamburgues|perro|hot\s?dog/i;
function stripPapaOffer(t) {
  const parts = String(t).match(/[^\n]+?(?:[.!?]+(?=\s|$)|$)\s*|\n+/gm) || [String(t)];
  const keep = parts.filter(p => !(/porci[oó]n(es)?\s+(extra\s+)?de\s+papa|papas?\s+(adicional|extra)|adicion\w*\s+(de\s+)?(la\s+)?papa/i.test(p) && /¿|\?|quieres|deseas|gustar|agreg|adicion/i.test(p)));
  const r = keep.join('').replace(/\n{3,}/g, '\n\n').trim();
  return /[\p{L}\p{N}]/u.test(r) ? r : '¿Deseas algo más para tu pedido?';
}
function catalogText(cfg, items) {
  return items.map(it => {
    const off = it.stock != null && +it.stock <= 0;
    const g = groupsOf(it, cfg.mods).map(m => `${m.name}: ${(m.opts || []).map(o => o.n + (+o.p ? ' (+' + money(o.p) + ')' : '')).join(' / ')}`).join(' ; ');
    return `[${it.id}] ${it.name} — ${money(it.price)} — ${it.cat || ''}${off ? ' — AGOTADO' : ''}${g ? ' — opciones: ' + g : ''}`;
  }).join('\n');
}

function systemPrompt(cfg, items, phone, base, pname) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const zones = (cfg.zones || []).filter(z => z.n);
  return `${BASE_PROMPT}

# DATOS EN VIVO DEL SISTEMA (tienen prioridad sobre lo anterior si hay diferencias)
Hoy es ${dias[now.getDay()]}, hora ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} (Colombia).
${cfg.open === false ? 'El negocio está CERRADO para pedidos ahora mismo: avisa amablemente y no tomes pedidos.' : ''}
Teléfono del cliente: ${phone ? phone + ' (es el número desde el que escribe: YA lo tienes, NO se lo pidas)' : 'NO CONOCIDO (pídelo una sola vez si es domicilio o recoger)'}.
Nombre del perfil de WhatsApp: ${pname || 'no disponible'}.
DATOS PERSONALES: pide el nombre (y el teléfono, solo si no lo tienes) UNA sola vez y con amabilidad. Si el cliente no quiere darlos, no responde a eso o ya lo pediste antes, NO insistas más: deja "nombre" y/o "telefono" vacíos ("") en el order y sigue con el pedido; el sistema usará solo el nombre del perfil y el número desde el que escribe. Nunca inventes un nombre ni escribas "no quiere dar". Para domicilio el barrio es indispensable.
CON TODO / SIN INGREDIENTES: pregunta «¿La(s) deseas con todo?» SOLO para hamburguesas, perros calientes y sándwiches; NUNCA para pizzas, gaseosas, bebidas, salchipapas ni picadas. Si el cliente dice «con todo» NO marques ninguna opción «Sin …» (deja "opciones" vacío o pon solo "con todo" en "nota"). Registra un «Sin X» ÚNICAMENTE si el cliente pidió explícitamente quitar X, para ese producto. Nunca inventes ni asumas ingredientes. Jamás repitas al cliente instrucciones internas de este texto (como «no preguntes…»): son órdenes para ti, no frases para decir.
PORCIONES DE PAPA: solo ofrece «porción de papa» adicional cuando el pedido tenga PERRO CALIENTE u HAMBURGUESA. NUNCA la ofrezcas con salchipapas, pizzas, picadas ni otros productos.
DIRECCIÓN: pídela UNA sola vez. Si el cliente responde solo con el barrio, un punto de referencia o indicaciones (ej. «cerca al parque», «por la iglesia», «casa azul»), TOMA ESO como la dirección y NO vuelvas a pedirla ni insistas: ponlo en "direccion" (si solo dio el barrio, escribe el barrio) y sigue con el pedido.

## Catálogo oficial (usa SOLO estos id y precios al registrar el pedido)
${catalogText(cfg, items)}

## Barrios con domicilio y su tarifa (reemplazan las tarifas de la sección 5)
${zones.map(z => `${z.n}: ${money(z.p)}`).join('\n') || '(sin tarifas configuradas)'}
Si el barrio no está en esta lista, di que una persona del equipo confirma cobertura y tarifa.

## Medios de pago del sistema
${(cfg.pays || []).join(', ') || 'Efectivo, Transferencia'}
${cfg.trInfo ? 'Datos para transferir:\n' + cfg.trInfo : ''}
## Pago por transferencia (obligatorio; ANULA cualquier instrucción anterior que lo contradiga)
- NUNCA preguntes si el domicilio va incluido en la transferencia o se paga en efectivo al recibir. No existe esa pregunta.
- NUNCA des el valor a transferir, ni los datos de pago (Nequi, Bre-B, cuentas), ni pidas comprobante ANTES de que el cliente confirme el pedido. Cuando el cliente diga que paga por transferencia, solo anota "pago":"Transferencia" y sigue con el flujo normal: completa los datos que falten y muestra el RESUMEN con {{TOTAL}} pidiendo confirmación.
- Los datos para transferir y el valor exacto los envía el sistema automáticamente en el mensaje de confirmación. Tú, al confirmar, responde solo "Pedido confirmado.".
- "pago_domicilio": usa "incluido" siempre, salvo que el cliente diga por su cuenta que el domicilio lo paga en efectivo al recibir (entonces "recibir"). No lo preguntes.

${base ? `# PEDIDO ANTERIOR DE ESTE CLIENTE (ya confirmado en esta conversación)
Cliente: ${base.name}${base.tipo === 'domicilio' ? ' (domicilio)' : ' (recoger)'}.
Productos (con su id del catálogo): ${base.lines && base.lines.length ? base.lines.map(l => `[${l.id}] ${l.name} x${l.qty}`).join(', ') : base.summary}
Estado: ${base.open ? 'EN PREPARACIÓN (todavía se puede agregar o cambiar algo)' : 'YA NO SE PUEDE MODIFICAR (está listo, ya salió o se cerró)'}.
Estado real en el sistema (dato en vivo): ${{ new: 'RECIBIDO, la cocina aún no lo ha empezado a preparar', received: 'EN COCINA, se está preparando', ready: base.tipo === 'domicilio' ? 'LISTO, ya salió o está por salir con el domiciliario' : 'LISTO PARA RECOGER', cancelled: 'CANCELADO' }[base.st] || 'sin información'}. El pedido se registró hace ${base.mins} minutos.
La conversación sigue abierta. Reglas para mensajes posteriores:
- Si el cliente pregunta por su pedido ("¿ya viene?", "¿cuánto falta?", "se demora", "¿qué pasó con mi pedido?"): responde con el estado real de arriba, en una o dos frases amables, sin inventar tiempos exactos. Si está RECIBIDO o EN COCINA, dile que ya lo estamos preparando y agradece la paciencia (usa los tiempos de demora del prompt solo si ya los conoces). Si está LISTO y es domicilio, dile que ya va en camino; si es para recoger, que puede pasar por él. Si está CANCELADO, avisa y ofrécele ayuda. Si lleva mucho más tiempo del normal, discúlpate y dile que se lo avisas a una persona del equipo. No envíes "order" en estos casos.
- Si el cliente quiere AGREGAR algo y el pedido está en preparación: toma solo lo nuevo (con la misma regla de no repetir lo ya pedido), ofrécele lo que falte (bebida, adicionales) solo si es útil, y al final muestra un resumen corto SOLO de lo agregado y pide confirmación. Cuando confirme, responde «Listo, lo agregué a tu pedido.» y envía "order" con "tipo":"adicion" y solo las líneas nuevas (no pidas nombre, teléfono, dirección ni pago otra vez: ya los tienes).
- Si quiere CAMBIAR o QUITAR algo del pedido anterior y está en preparación: en ESE MISMO mensaje confirma con una frase corta («Listo, avisamos a cocina del cambio.») y envía "order" con "tipo":"cambio". NUNCA digas solo «voy a cambiarlo» sin enviar el "order". Campos del cambio: "quitar":[{"id":<id del producto del PEDIDO ANTERIOR que se quita o reemplaza>,"qty":1}] y "lineas":[los productos NUEVOS que lo reemplazan, con su id del catálogo; vacío si solo se quita algo] y "nota": descripción corta (ej.: «Cambiar HIT 250ml por HIT 1L»). Ejemplo: tenía HIT 250ml y quiere el de 1 L → quitar:[{"id":<id HIT 250ml>,"qty":1}], lineas:[{"id":<id HIT 1L>,"qty":1}]. Si el cambio es solo una indicación («sin cebolla en una hamburguesa») usa solo "nota" y deja quitar y lineas vacíos. No repitas en "lineas" productos que no cambian.
- Si el pedido ya no se puede modificar: explica amablemente que ya salió o está listo y ofrécele hacer un pedido nuevo (se pide todo como un pedido nuevo, con "tipo":"domicilio" o "recoger", incluyendo solo lo del pedido nuevo).
- Si el cliente quiere un pedido totalmente distinto, tómalo como pedido nuevo.
- MUY IMPORTANTE: en "order" con "tipo":"adicion" incluye ÚNICAMENTE los productos nuevos. NUNCA repitas los productos del pedido anterior ni cambies su id. Al resumir una adición, muestra solo lo agregado y su valor, no el total de todo el pedido.
` : ''}
# REGLA DE TELÉFONO
Si el teléfono del cliente figura como NO CONOCIDO, debes pedírselo (para domicilio o para recoger) ANTES de mostrar el resumen final. No confirmes un pedido sin teléfono.

# FORMATO DE RESPUESTA (obligatorio)
Responde SIEMPRE con un único objeto JSON, sin texto fuera de él:
{"reply": "mensaje para el cliente", "carrito": null, "order": null}
- "reply" sigue todas las reglas de conversación y estilo anteriores (breve, una pregunta por mensaje).
- VARIEDADES (obligatorio): si el cliente pide un producto genérico que en el catálogo tiene varias opciones (hamburguesa, perro caliente, pizza, salchipapa, picada, choripollo, sándwich, gaseosa, etc.), NO elijas tú ni asumas la más barata ni la primera. Pregúntale de cuál quiere, nombrando las opciones disponibles con su precio (usa SOLO los nombres y precios del catálogo; ej.: "¿Cuáles hamburguesas deseas? Tenemos: <opción 1> $X, <opción 2> $Y…"). Si pide varias unidades (ej. 3 hamburguesas), pregunta cuántas de cada tipo. Solo agrega al carrito cuando el cliente haya dicho cuál. Si el producto tiene una sola opción, no preguntes. No agregues al carrito productos de los que aún no definió la variedad.
- CARRITO LIMPIO: en cada respuesta reconstruye "carrito" desde cero con lo que el cliente pidió en esta conversación (sin repetir líneas ya contadas ni duplicar cantidades). Si el cliente cambia de domicilio a recoger (o al revés), solo cambia "tipo"; los productos no se duplican. No escribas totales parciales en mensajes intermedios (no digas «tu pedido queda en $…» antes del resumen): pregunta lo siguiente que falte.
- RESUMEN: cuando ya tengas todo (productos, tipo, datos, pago) y vayas a pedir la confirmación, escribe EXACTAMENTE esta estructura (el sistema arma la lista con precios y los botones de respuesta): una línea con {{RESUMEN}}, luego las líneas de 📍 Dirección (o 🛍️ Recoge en el local), 👤 Nombre y 💳 Pago. NO escribas la lista de productos, ni el total, ni la pregunta "¿confirmas?"; el sistema agrega "Responde SÍ para confirmar / CAMBIAR para modificar". Si el cliente responde CAMBIAR, pregúntale qué desea modificar y vuelve a mostrar el {{RESUMEN}}. Si responde SÍ (o similar), confirma el pedido normalmente.
- TOTALES: NUNCA calcules ni escribas cantidades de dinero de totales. Donde necesites decir el subtotal, el domicilio o el total, escribe exactamente {{SUBTOTAL}}, {{DOMICILIO}} o {{TOTAL}} y el sistema pondrá el valor correcto. Solo puedes escribir precios unitarios que estén en el catálogo.
- CARRITO: en CADA respuesta incluye además "carrito" con TODO lo que el cliente lleva pedido hasta ahora en el pedido nuevo: {"tipo":"domicilio"|"recoger"|"","barrio":"(exacto de la lista, si ya lo sabes)","lineas":[{"id":<id del catálogo>,"qty":1,"opciones":["..."]}]}. Si todavía no ha pedido nada, "carrito" es null. Si es una adición a un pedido anterior, "carrito" lleva SOLO los productos nuevos y "tipo":"adicion".
- "order" es null en todos los mensajes, EXCEPTO en el mensaje en que el cliente CONFIRMA el resumen final (dice sí, confirmo, dale, etc.). En ese mensaje "reply" debe ser solo "Pedido confirmado." y "order" lleva:
{"tipo":"domicilio"|"recoger"|"adicion"|"cambio","nombre":"","telefono":"","direccion":"","barrio":"(exacto de la lista)","pago":"(uno de los medios de pago)","pago_domicilio":"recibir"|"incluido"|"","nota":"","lineas":[{"id":<id del catálogo>,"qty":1,"opciones":["nombres de opciones del catálogo"],"nota":"cambios libres, p. ej. sin cebolla","unidades_con_cambio":<opcional>}]}
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
  try { const j = JSON.parse(raw); return { reply: String(j.reply == null ? '' : j.reply).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500), order: j.order && typeof j.order === 'object' ? j.order : null, carrito: j.carrito && typeof j.carrito === 'object' ? j.carrito : null }; }
  catch (e) { return { reply: clean(String(raw).replace(/[{}"]/g, ''), 600), order: null }; }
}

// Convierte la orden del modelo en un pedido válido para el POS. Nunca se pierde un pedido: lo dudoso queda marcado para revisar.
// el cliente no quiso dar su nombre: se usa el del perfil de WhatsApp
const goodName = n => { const v = clean(n, 80); return v && !/^(no\b|sin\b|n\/?a$|ning[uú]n|prefiero|cliente$|an[oó]nimo|desconocido)/i.test(v) ? v : ''; };
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
    if (!clean(o.direccion, 200)) o.direccion = clean((z ? z.n : o.barrio) || '', 120) ? clean((z ? z.n : o.barrio), 120) + ' (sin dirección exacta)' : ''; // si solo dio el barrio, ese es el dato
    if (!clean(o.direccion, 200)) flags.push('sin dirección');
  }
  const digits = String(o.telefono || '').replace(/\D/g, '');
  const phone = digits.length >= 7 ? digits.slice(-10) : (phoneKnown || '');
  if (!phone) flags.push('sin teléfono');
  const pagoBase = clean(o.pago, 30) || ((cfg.pays || [])[0] || '');
  const tr = /transfer|nequi|bre|davi/i.test(pagoBase);
  const payTxt = dom ? (tr && !add ? pagoBase + (o.pago_domicilio === 'recibir' ? ' · domicilio al recibir' : ' · domicilio incluido') : pagoBase) : '';
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const note = [add ? '➕ ADICIÓN al pedido anterior (mismo cliente, sin cobrar domicilio otra vez)' : '', '💬 WhatsApp', clean(add ? '' : o.nota, 200), !dom && !add ? 'Pago: ' + pagoBase : '', flags.length ? '⚠ REVISAR: ' + flags.join('; ') : ''].filter(Boolean).join(' | ').slice(0, 300);
  return {
    type: dom ? 'domicilio' : 'mesa', table: (add ? (dom ? '' : PICK) : (dom ? zone : PICK)).slice(0, 40),
    name: clean((goodName(o.nombre) || sender) + (add ? ' (adición)' : ''), 80), phone: phone.slice(0, 30), address: dom ? clean(o.direccion, 200) : '',
    note, pay: payTxt.slice(0, 40), fee, lines, total: sub + fee, status: 'new', source: 'whatsapp',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

// Calcula subtotal, domicilio y total con los precios del catálogo (no confía en las cuentas del modelo)
function calcCart(c, cfg, items) {
  if (!c || !Array.isArray(c.lineas) || !c.lineas.length) return null;
  const dom = norm(c.tipo).startsWith('dom');
  const d = buildOrder({ tipo: dom ? 'domicilio' : 'recoger', barrio: c.barrio, direccion: 'x', telefono: '0000000', lineas: c.lineas }, cfg, items, '0000000', 'x');
  if (!d.lines.length || d.lines.some(l => String(l.id).startsWith('x'))) return null;
  return { total: d.total, fee: d.fee, lines: d.lines, dom, zone: dom ? clean(d.table, 60) : '' };
}
// Saludo fijo: es lo primero que envía el bot en una conversación nueva
const GREETING = '¡Hola! Bienvenido. ¿Qué deseas pedir hoy? Puedes realizar tu pedido por aquí o consultar nuestro menú digital: https://comd-rap-el-carbon-menu.vercel.app/';
const GREET_ONLY = /^[¡!\s]*(hola+|ola|holi|hey|buenas|buenos dias|buen dia|buenas tardes|buenas noches|buenas tardes noches|saludos|que tal|hello|hi)( (veci|vecino|vecina|amigo|amiga|a todos|como estas|como esta|como estan))?[\s!.,?]*$/;
// Resumen del pedido con formato fijo (lo arma el servidor con los precios reales; el modelo no lo escribe)
const SUMMARY_FOOT = '✅ Responde *SÍ* para confirmar\n✏️ Responde *CAMBIAR* para modificar';
function summaryBlock(calc) {
  const L = ['*Tu pedido*'];
  (calc.lines || []).forEach(l => {
    L.push(l.qty + ' × ' + l.name + ' — ' + money((+l.price || 0) * l.qty));
    (l.mods || []).forEach(m => L.push('   └ ' + m));
  });
  if (calc.dom && calc.fee > 0) L.push('Domicilio' + (calc.zone ? ' (' + calc.zone + ')' : '') + ' — ' + money(calc.fee));
  L.push('*Total — ' + money(calc.total) + '*');
  return L.join('\n');
}
// Respaldo sin cálculo: si el modelo escribe el resumen en una sola línea, se parte en líneas ordenadas
function tidyFlat(text) {
  let t = String(text);
  if (!/responde\s+\*?s[ií](?![\p{L}])|tu\s+pedido\s+queda\s+as[ií]|resumen\s+del\s+pedido/iu.test(t) || t.split('\n').length > 3) return t;
  t = t.replace(/(tu\s+pedido\s+queda\s+as[ií]\s*:?)\s*/i, '*Tu pedido*\n')
    .replace(/(?:\s+y\s+|,\s*|\.\s+)(?=\d+\s*[x×]\s)/g, '\n')
    .replace(/\s*([\u{1F4CD}\u{1F464}\u{1F4B3}\u{1F6CD}\u{1F4DE}]\uFE0F?)/gu, '\n$1')
    .replace(/[.\s]*[\u2705\u270F]\uFE0F?\s*(Responde)/giu, '\n$1')
    .replace(/[.\s]*(Responde\s+\*?s[ií](?![\p{L}]))/iu, '\n\n✅ $1')
    .replace(/[.\s]*(Responde\s+\*?cambiar\b)/i, '\n✏️ $1')
    .replace(/(\p{L}|\d)\.(?=\n)/gu, '$1');
  t = t.replace(/\n{3,}/g, '\n\n').trim().replace(/\.$/, '');
  return /cambiar/i.test(t) ? t : t + '\n✏️ Responde CAMBIAR para modificar';
}
function ensureSummary(text, calc) {
  let t = String(text);
  if (!calc || !(calc.total > 0)) return tidyFlat(t);
  if (/\{\{\s*RESUMEN\s*\}\}/i.test(t)) {
    t = t.replace(/\{\{\s*RESUMEN\s*\}\}/gi, () => summaryBlock(calc));
    return /responde\s+\*?s[ií]/i.test(t) ? t : t.replace(/\n+$/, '') + '\n\n' + SUMMARY_FOOT;
  }
  const hdr = /resumen\s+(del|de\s+tu)\s+pedido|^[*_\s]*tu\s+pedido(\s+queda\s+as[ií])?\s*:?[*_\s]*(\n|$)|tu\s+pedido\s+queda\s+as[ií]\s*:/im.test(t);
  const ask = /confirm|responde\s+\*?s[ií](?![\p{L}])|¿[^?\n]*(est[aá]\s+(todo\s+)?(bien|correcto)|correcto|todo\s+bien|procedo|lo\s+(enviamos|mando|env[ií]o))[^?\n]*\?/iu.test(t);
  if (/pedido confirmado/i.test(t) || !(hdr || ask)) return t;
  // datos del cliente: se extraen aunque el modelo los escriba todos en una línea
  const T = t.replace(/\*/g, '');
  const grab = (re) => { const m = T.match(re); return m ? m[1].replace(/[\s.,;]+$/, '').trim() : ''; };
  const STOP = '(?=\\s*(?:Direcci[oó]n|Barrio|Nombre|Cliente|Tel[eé]fono|Pago|M[eé]todo|Recoge|Responde|[\\u{1F4CD}\\u{1F464}\\u{1F4B3}\\u{1F6CD}\\u2705\\u270F]|\\n|$))';
  const f = (lab) => grab(new RegExp('(?:' + lab + ')\\s*:\\s*(.+?)' + STOP, 'isu'));
  const dir = f('Direcci[oó]n|Barrio'), nom = f('Nombre|Cliente'), tel = f('Tel[eé]fono'), pago = f('Pago|M[eé]todo de pago');
  const K = [];
  if (calc.dom) { if (dir) K.push('📍 Dirección: ' + dir); } else K.push('🛍️ Recoge en el local');
  if (nom) K.push('👤 Nombre: ' + nom);
  if (tel) K.push('📞 Teléfono: ' + tel);
  if (pago) K.push('💳 Pago: ' + pago);
  return summaryBlock(calc) + (K.length ? '\n' + K.join('\n') : '') + '\n\n' + SUMMARY_FOOT;
}
function applyTotals(text, calc) {
  let t = String(text);
  if (calc) {
    t = t.replace(/\{\{\s*SUBTOTAL\s*\}\}/gi, money(calc.total - calc.fee)).replace(/\{\{\s*DOMICILIO\s*\}\}/gi, money(calc.fee)).replace(/\{\{\s*TOTAL\s*\}\}/gi, money(calc.total));
    // respaldo: si el modelo escribió el total a mano, se corrige con el valor real
    t = t.replace(/(^|[^a-záéíóúñ])(total\b[^\n$\d]{0,30}?)\$\s?\d(?:[\d.,]*\d)?/gi, (m, a, b) => a + b + money(calc.total));
    t = t.replace(/(\b(?:queda|quedar[ií]a|sale|salen|ser[ií]a|ser[ií]an)\s+(?:en|por)|\bpedido\s+(?:es\s+de|son|ser[ií]a))(\s*)\$\s?\d(?:[\d.,]*\d)?/gi, (m, a, b) => a + b + money(calc.total));
    t = t.replace(/(transfier\w*|transferir\w*|consign\w*)([^\n$\d]{0,40}?)\$\s?\d(?:[\d.,]*\d)?/gi, (m, a, b) => a + b + money(calc.total));
    t = t.replace(/(^|[^a-záéíóúñ])(subtotal\b[^\n$\d]{0,30}?)\$\s?\d(?:[\d.,]*\d)?/gi, (m, a, b) => a + b + money(calc.total - calc.fee));
  }
  return t.replace(/\{\{[^}]*\}\}/g, '').replace(/[ \t]+\n/g, '\n');
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

function applyRemove(bl, quitar) {
  const rm = {}; (quitar || []).forEach(r => { rm[r.id] = (rm[r.id] || 0) + r.qty; });
  return (bl || []).map(l => { const n = Math.min(rm[l.id] || 0, l.qty); rm[l.id] = (rm[l.id] || 0) - n; return Object.assign({}, l, { qty: l.qty - n }); }).filter(l => l.qty > 0);
}
function buildChange(o, base, sender, cfg, items) {
  const dom = base.tipo === 'domicilio', bl = base.lines || [];
  // lo que se quita: solo productos que de verdad están en el pedido anterior
  const quitar = (Array.isArray(o.quitar) ? o.quitar : []).map(r => ({ id: String(r && r.id), qty: Math.max(1, Math.min(99, Math.floor(+(r && r.qty)) || 1)) })).filter(r => bl.some(l => String(l.id) === r.id));
  const lin = Array.isArray(o.lineas) ? o.lineas.filter(l => l && !bl.some(b => String(b.id) === String(l.id) && !quitar.some(r => r.id === String(l.id)))) : [];
  let nuevas = [];
  if (lin.length && items) { const d = buildOrder({ tipo: 'recoger', telefono: base.phone || '0000000', nombre: 'x', lineas: lin }, cfg, items, base.phone || '0000000', 'x'); nuevas = d.lines.filter(l => !String(l.id).startsWith('x')); }
  const nameOf = id => ((bl.find(l => String(l.id) === id) || {}).name) || id;
  const rmTxt = quitar.map(r => r.qty + ' ' + nameOf(r.id));
  const addTxt = nuevas.map(l => l.qty + ' ' + l.name);
  const auto = rmTxt.length || addTxt.length ? [rmTxt.length ? 'QUITAR ' + rmTxt.join(', ') : '', addTxt.length ? 'AGREGAR ' + addTxt.join(', ') : ''].filter(Boolean).join(' → ') : '';
  const txt = clean(auto || o.nota || (Array.isArray(o.lineas) && o.lineas[0] && o.lineas[0].nota) || 'cambio solicitado', 150);
  const restado = quitar.reduce((a, r) => { const it = (items || []).find(i => String(i.id) === r.id); return a + (it ? (+it.price || 0) * r.qty : 0); }, 0);
  return {
    type: dom ? 'domicilio' : 'mesa', table: dom ? '' : PICK, name: clean((goodName(base.name) || sender) + ' (cambio)', 80), phone: clean(base.phone, 30), address: dom ? clean(base.address, 200) : '',
    note: '✏️ CAMBIO AL PEDIDO ANTERIOR | 💬 WhatsApp', pay: '', fee: 0,
    lines: [{ id: 'cambio', name: '⚠ CAMBIO: ' + txt, qty: 1, price: 0, mods: [], cat: '' }].concat(nuevas),
    remove: quitar, total: Math.max(0, nuevas.reduce((a, l) => a + l.price * l.qty, 0) - restado), status: 'new', source: 'whatsapp', createdAt: admin.firestore.FieldValue.serverTimestamp()
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
  return '¡Hola! 👋 ' + (byHours ? 'Por ahora estamos *CERRADOS* 🔒.' : 'Hoy no estamos recibiendo pedidos por este medio.') +
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
    const sNum = sender.replace(/[\s+\-()]/g, ''), pname = clean(q.name || q.senderName || q.pushname || '', 60) || (/^\d+$/.test(sNum) || /^lid:/i.test(sender) ? '' : sender);
    const dispName = pname || sender; // nombre que se usa si el cliente no da el suyo
    const ref = db.collection('bot_chats').doc(key);
    // Comando de prueba: "/nuevo" borra la memoria de este chat para volver a ver el saludo de bienvenida
    if (/^\/?nuevo chat$|^\/nuevo$|^\/reiniciar$/i.test(text.trim())) {
      await ref.set({ msgs: [], at: 0, cart: null, closedAt: 0 });
      return res.status(200).json({ replies: [{ message: 'Chat reiniciado ✅. Ahora escribe "Hola" para ver el saludo.' }] });
    }
    const snap = await ref.get();
    // El cliente ya hizo el pedido en la página y además lo manda por WhatsApp ("*Nuevo pedido a domicilio* #AB12"):
    // no se crea otro pedido; se busca el que ya está en cocina y se le confirma.
    // Contactos ignorados y chats que atiende una persona (se configuran desde el POS → WhatsApp)
    let wcfg = {};
    try { const w = await db.collection('pos_wacfg').doc('main').get(); wcfg = w.exists ? w.data() : {}; } catch (e) { console.error('wacfg', e && e.message); }
    const tail = digits.slice(-10), hit = arr => Array.isArray(arr) && arr.some(x => { x = String(x); return x === key || (x.length >= 10 && /^\d+$/.test(x) && x.slice(-10) === (phoneKnown || tail)); });
    if (hit(wcfg.ignore)) return res.status(200).json({ replies: [] });
    await mirrorChat(db, key, sender, phoneKnown, q, [{ r: 'u', t: text }], '');
    if (hit(wcfg.manual)) return res.status(200).json({ replies: [] });
    const mp = text.match(/Nuevo pedido\s+(a domicilio|para recoger)[^#]{0,5}\*?\s*#\s*([A-Za-z0-9]{4})\b/i);
    if (mp) {
      const code = mp[2].toUpperCase(), isDom = /domicilio/i.test(mp[1]);
      let od = null, oid = '';
      try {
        const qs = await db.collection('orders').orderBy('createdAt', 'desc').limit(120).get();
        qs.forEach(d => { if (!od && d.id.slice(-4).toUpperCase() === code) { od = d.data(); oid = d.id; } });
      } catch (e) { console.error('buscar pedido', e && e.message); }
      let out;
      if (od && od.status !== 'cancelled') {
        const fn = String(od.name || '').trim().split(/\s+/)[0];
        const nm = fn ? fn[0].toUpperCase() + fn.slice(1).toLowerCase() : '';
        const dom = od.type === 'domicilio' || isDom;
        out = od.status === 'ready'
          ? '¡Hola' + (nm ? ' ' + nm : '') + '! 👋 Tu pedido #' + code + ' ya está listo ' + (dom ? 'y estamos esperando al domiciliario 🛵' : 'para recoger 🍔') + '. ¡Gracias!'
          : '¡Hola' + (nm ? ' ' + nm : '') + '! 👋 Tu pedido #' + code + ' ya está en cocina 👨‍🍳. Total: ' + money(od.total) + '. ' + (dom ? 'Te avisamos cuando salga con el domiciliario.' : 'Te avisamos cuando esté listo para recoger.') + ' ¡Gracias!';
        const info = { tipo: dom ? 'domicilio' : 'recoger', name: clean(od.name, 80), phone: clean(od.phone, 30), address: clean(od.address, 200), zone: dom ? clean(od.table, 60) : '', pago: clean(od.pay, 30), lines: Array.isArray(od.lines) ? od.lines : [] };
        const hist0 = (snap.exists && Array.isArray(snap.data().msgs) ? snap.data().msgs : []).concat([{ r: 'u', t: text }, { r: 'a', t: out }]).slice(-30);
        await ref.set({ msgs: hist0, at: Date.now(), lastOrder: oid, lastInfo: info, lastAt: Date.now() });
        await mirrorChat(db, key, sender, phoneKnown, q, [{ r: 'a', t: out }], oid);
      } else out = od ? 'Ese pedido aparece como cancelado. Si quieres, dime qué deseas pedir y te ayudo.' : 'Recibí tu mensaje 🙌 Estamos verificando tu pedido #' + code + ', un momento por favor.';
      return res.status(200).json({ replies: [{ message: out }] });
    }
    let msgs = [], base = null;
    const prev = snap.exists ? snap.data() : {};
    if (snap.exists && Date.now() - (prev.at || 0) < 8 * 3600e3) {
      msgs = Array.isArray(prev.msgs) ? prev.msgs : [];
      if (prev.lastOrder && prev.lastInfo) {
        let st = '', sum = '';
        try { const bs = await db.collection('orders').doc(prev.lastOrder).get(); if (bs.exists) { const b = bs.data(); st = b.status; sum = (b.lines || []).map(l => l.qty + ' ' + l.name + ((l.mods || []).length ? ' (' + l.mods.join(', ') + ')' : '')).join(', '); } } catch (e) {}
        base = Object.assign({}, prev.lastInfo, { lines: Array.isArray(prev.lastInfo.lines) ? prev.lastInfo.lines : [], summary: sum || '(sin detalle)', st, mins: Math.max(0, Math.round((Date.now() - (prev.lastAt || Date.now())) / 60000)), open: (st === 'new' || st === 'received') && Date.now() - (prev.lastAt || 0) < 3 * 3600e3 });
      }
    }

    // Pregunta por el estado / demora de su pedido: se responde con el estado REAL del sistema, sin depender de la IA
    if (base && base.st && STATUS_Q.test(text) && !ORDER_WORDS.test(text)) {
      const m = base.mins, dom = base.tipo === 'domicilio';
      const out = {
        new: 'Tu pedido fue recibido hace ' + m + ' min y está en la cola de la cocina 🙌. Apenas empiecen a prepararlo seguimos avanzando. ¡Gracias por tu paciencia! 🙏',
        received: 'Tu pedido está en preparación en este momento 👨‍🍳 (lo recibimos hace ' + m + ' min). Cuando esté listo ' + (dom ? 'sale de inmediato con el domiciliario' : 'te avisamos para que pases a recogerlo') + '. ¡Gracias por tu paciencia! 🙏',
        ready: dom ? 'Tu pedido está listo, estamos esperando al domiciliario 🛵. ¡Gracias por tu paciencia! 🙏' : 'Tu pedido ya está listo para recoger 🍔. ¡Te esperamos!',
        cancelled: 'Tu pedido aparece como cancelado. Si no fue lo que querías, escríbeme y te ayudo a hacerlo de nuevo.'
      }[base.st];
      if (out) {
        await ref.set({ msgs: msgs.concat([{ r: 'u', t: text }, { r: 'a', t: out }]).slice(-30), at: Date.now(), lastOrder: prev.lastOrder || null, lastInfo: prev.lastInfo || null, lastAt: prev.lastAt || 0 });
        await mirrorChat(db, key, sender, phoneKnown, q, [{ r: 'a', t: out }], prev.lastOrder);
        return res.status(200).json({ replies: [{ message: out }] });
      }
    }

    // Fuera de horario (o cerrado a mano): responder CERRADO sin gastar IA, salvo que el cliente ya tenga un pedido abierto
    if ((cfg.open === false || !inHours(cfg)) && !(base && base.open)) {
      // El aviso de cerrado se envía UNA sola vez: si el cliente sigue escribiendo («listo», «gracias»…) no se repite en 8 horas
      if (prev.closedAt && Date.now() - prev.closedAt < 8 * 3600e3) return res.status(200).json({ replies: [] });
      const cm = closedText(cfg);
      try { await ref.set({ closedAt: Date.now() }, { merge: true }); } catch (e) { console.error('closedAt', e && e.message); }
      await mirrorChat(db, key, sender, phoneKnown, q, [{ r: 'a', t: cm }], '');
      return res.status(200).json({ replies: [{ message: cm, delay: 1 }] });
    }

    // Si el bot acababa de pedir la dirección/barrio y el cliente responde algo corto, ESO es la dirección: no se vuelve a preguntar
    const lastA = [...msgs].reverse().find(m => m.r === 'a');
    const addrAns = !!(lastA && /direcci[oó]n|barrio|ubicaci[oó]n|d[oó]nde\s+(est[aá]s|te|queda)/i.test(lastA.t) && text.length <= 100 && !/\?/.test(text) && !ORDER_WORDS.test(text) && !STATUS_Q.test(text));
    const addrHint = addrAns ? '\n\nATENCIÓN: acabas de pedir la dirección/barrio y el cliente respondió: «' + text.replace(/[«»]/g, '') + '». Eso ES su dirección (o su barrio). Guárdalo en "direccion" y también en "barrio" (si coincide con la lista úsalo exacto; si no está en la lista, deja ese mismo texto y el equipo confirma la tarifa). NO vuelvas a pedir la dirección ni el barrio: pasa directo al siguiente paso (medio de pago o el resumen).' : '';
    const raw = await openai([{ role: 'system', content: systemPrompt(cfg, items, phoneKnown, base, pname) + addrHint },
      ...msgs.map(m => ({ role: m.r === 'u' ? 'user' : 'assistant', content: m.t })), { role: 'user', content: text }]);
    let { reply, order, carrito } = parseModel(raw);
    let out = reply || 'Un momento, por favor.';
    // Los totales los calcula el servidor (el modelo se equivoca sumando): se usan los precios reales del catálogo
    const cartNow = order && order.lineas ? order : (carrito && carrito.lineas && carrito.lineas.length ? carrito : (prev.cart || null)); // si el modelo olvida el carrito, se usa el último conocido
    const hasBase = ((cartNow && cartNow.lineas) || []).some(l => { const it = items.find(i => String(i.id) === String(l.id)); return it && BASE_PAPA.test((it.cat || '') + ' ' + (it.name || '')); });
    if (!hasBase) out = stripPapaOffer(out);
    if (!order) out = out.replace(/(^|\n)\s*(listo[.,!]*\s*)?tu pedido\s+(queda|es|son|ser[ií]a)\s+(en|de|por)?\s*\$\s?\d(?:[\d.,]*\d)?[.,]?\s*(?=¿)/i, '$1$2');
    out = out.replace(/[,;]?\s*(y\s+)?en\s+(las\s+)?(pizzas?|gaseosas?|bebidas?)[^.\n?]*no\s+pregunt\w*[^.\n]*\.?/gi, '').replace(/[,;]?\s*no\s+pregunt(es|ar)\s+(que\s+)?si[^.\n]*\.?/gi, '').replace(/\?,\s*$/gm, '?');
    const calcNow = calcCart(cartNow, cfg, items);
    if (!order && !(base && base.open)) out = ensureSummary(out, calcNow);
    out = applyTotals(out, calcNow);
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
      else if (kind === 'cambio' && base && base.open) { doc = buildChange(order, base, dispName, cfg, items); doc.addTo = prev.lastOrder; doc.kind = 'cambio'; }
      else if (kind === 'adicion' && base && base.open) { doc = buildOrder(Object.assign({}, order, { tipo: base.tipo, nombre: base.name, direccion: base.address, pago: base.pago, telefono: base.phone }), cfg, items, base.phone || phoneKnown, dispName, base); doc.addTo = prev.lastOrder; doc.kind = 'adicion'; if (warn) doc.note += ' | ⚠ REVISAR: confirmar que sean solo productos nuevos'; }
      else if ((kind === 'adicion' || kind === 'cambio') && base) { // el pedido anterior ya no se puede tocar: se registra como pedido nuevo con los mismos datos
        doc = kind === 'cambio' ? null : buildOrder(Object.assign({}, order, { tipo: base.tipo, nombre: base.name, telefono: base.phone, direccion: base.address, barrio: base.zone, pago: base.pago }), cfg, items, base.phone || phoneKnown, dispName);
        if (!doc) out = 'Ese pedido ya salió o está listo, por eso no puedo cambiarlo. Una persona del equipo te ayuda enseguida.';
      } else doc = buildOrder(order, cfg, items, phoneKnown, dispName);
      if (doc) {
        if (!doc.lines.length) out = 'Disculpa, no pude registrar el pedido. Una persona del equipo te ayuda enseguida.';
        else {
          const r = await db.collection('orders').add(doc);
          orderId = r.id;
          const real = doc.lines.filter(l => !String(l.id).startsWith('x') && l.id !== 'cambio').map(l => ({ id: l.id, name: l.name, qty: l.qty }));
          if (doc.addTo && doc.kind === 'cambio') addInfo = Object.assign({}, prev.lastInfo, { lines: mergeLines(applyRemove(bl, doc.remove), real) });
          else if (doc.addTo && doc.kind === 'adicion') addInfo = Object.assign({}, prev.lastInfo, { lines: mergeLines(bl, real) });
          else if (doc.kind !== 'cambio') info = { tipo: doc.type === 'domicilio' ? 'domicilio' : 'recoger', name: doc.name, phone: doc.phone, address: doc.address, zone: doc.table === PICK ? '' : doc.table, pago: clean(order.pago, 30), lines: real };
          try { // aviso push a los equipos (igual que el menú web)
            await fetch('https://' + req.headers.host + '/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: orderId }), signal: AbortSignal.timeout(4000) });
          } catch (e) {}
        }
      }
    }
    if (orderId && info && /transfer|nequi|bre|davi/i.test(String(order.pago || ''))) { // al confirmar: el sistema da el valor exacto y los datos de pago
      const rec = String(order.pago_domicilio || '') === 'recibir' && info.tipo === 'domicilio';
      const tot = (calcCart(order, cfg, items) || {}).total, fee = (calcCart(order, cfg, items) || {}).fee || 0;
      if (tot) out = 'Pedido confirmado. ✅\n\n💳 Para dejarlo listo, transfiere *' + money(rec ? tot - fee : tot) + '*' + (rec ? ' (el domicilio de ' + money(fee) + ' lo pagas en efectivo al recibir)' : '') + '.' + (cfg.trInfo ? '\n\n' + cfg.trInfo : '') + '\n\nEnvíanos el comprobante por aquí para verificar el pago.';
    }
    // Primer mensaje de una conversación nueva: siempre sale primero el saludo fijo
    let parts = [out];
    if (!msgs.length && !orderId && !(order && cfg.open === false)) {
      if (GREET_ONLY.test(norm(text))) { out = GREETING; parts = [GREETING]; }
      else { parts = [GREETING, out]; out = GREETING + '\n\n' + out; }
    }
    const hist = msgs.concat([{ r: 'u', t: text }, { r: 'a', t: out }]).slice(-30);
    const save = { msgs: hist, at: Date.now(), lastOrder: prev.lastOrder || null, lastInfo: prev.lastInfo || null, lastAt: prev.lastAt || 0, cart: (!orderId && cartNow && !/adic/i.test(String(cartNow.tipo || ''))) ? cartNow : null };
    if (info) { save.lastOrder = orderId; save.lastInfo = info; save.lastAt = Date.now(); }
    else if (addInfo) save.lastInfo = addInfo;
    await ref.set(save);
    await mirrorChat(db, key, sender, phoneKnown || (save.lastInfo && save.lastInfo.phone) || '', q, [{ r: 'a', t: out }], save.lastOrder);
    return res.status(200).json({ replies: parts.map((m, i) => i ? { message: m, delay: 2 } : { message: m }) });
  } catch (e) {
    console.error('bot', e && e.message);
    return res.status(200).json({ replies: [{ message: 'Disculpa, tuve un problema. Un momento, ya te ayuda una persona del equipo.' }] });
  }
};
