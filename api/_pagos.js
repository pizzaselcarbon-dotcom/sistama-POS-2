// Funciones compartidas por /api/pago (correo) y /api/notif (notificaciones del Android).
const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('crypto');

function getDb() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return admin.firestore();
}
const money = n => '$' + Math.round(+n || 0).toLocaleString('es-CO');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// ¿Está activado este método? (se cambia desde el POS: Verificador → Activar/Desactivar). Por defecto, sí.
async function enabled(db, src) {
  try { const d = await db.collection('pos_pagos_cfg').doc('main').get(); const c = d.exists ? d.data() : {}; return c[src] !== false; }
  catch (e) { return true; }
}

// Guarda el pago (si no existe ya) y avisa con push. Devuelve {ok, dup, sent}
async function savePago(db, id, p, host, altIds) {
  for (const a of altIds || []) { const x = await db.collection('pos_pagos').doc(a).get(); if (x.exists) return { ok: true, dup: true, sent: 0 }; }
  try { await db.collection('pos_pagos').doc(id).create(p); }
  catch (e) { return { ok: true, dup: true, sent: 0 }; }
  let sent = 0;
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE && Date.now() - p.at < 30 * 60 * 1000) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || ('https://' + (host || 'localhost')), process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
    const payload = JSON.stringify({ title: '💰 Pago recibido ' + money(p.amount), body: [p.bank, p.payer].filter(Boolean).join(' · ') || 'Transferencia', tag: 'pago-recibido' });
    const subs = await db.collection('pos_push').get();
    await Promise.all(subs.docs.map(async d => {
      const s = d.data().sub;
      if (!s || !s.endpoint) return;
      try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete().catch(() => {}); }
    }));
  }
  return { ok: true, sent };
}

// ---- lectura del texto de una notificación (Nequi, Bancolombia, Daviplata...) ----
function montoDe(t) {
  const re = /(?:\$|COP)\s*([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)/gi;
  let m;
  while ((m = re.exec(t))) {
    let s = m[1].replace(/\s/g, '');
    const ult = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (ult > -1 && s.length - ult - 1 <= 2 && /[.,]/.test(s.slice(0, ult))) s = s.slice(0, ult);
    else if (ult > -1 && s.length - ult - 1 <= 2 && s.length - ult - 1 !== 3) s = s.slice(0, ult);
    s = s.replace(/[.,]/g, '');
    const n = parseInt(s, 10);
    if (n >= 1 && n < 100000000) return n;
  }
  return 0;
}
function montoSinSigno(t) {
  const m = /(?:recibiste|te enviaron|te han enviado|te llegaron|has recibido|te transfirieron|te envi[oó]|te mand[oó]|te pag[oó])\s+\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*|[0-9]+)(?![0-9:])/i.exec(t);
  if (!m) return 0;
  const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
  return n >= 1 && n < 100000000 ? n : 0;
}
const NAME = "[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ*\\.]+(?:[ \\t]+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ*\\.]+){0,3}";
function pagador(t) {
  const pats = [
    new RegExp('(?:^|[\\n¡!>:]\\s*)(' + NAME + ')\\s+te\\s+(?:envi[oó]|mand[oó]|pag[oó]|transfiri[oó]|consign[oó])'),
    new RegExp('(?:de|desde)\\s+(' + NAME + ')'),
    /(?:enviado por|enviada por|remitente:?|origen:?)\s*([^\n.,$]{3,40})/i
  ];
  for (const p of pats) {
    const r = p.exec(t);
    if (r) { const n = r[1].trim(); if (!/^(tu|su|la|el|una|un|nequi|bancolombia|daviplata|davivienda|bre|te|recibiste)\b/i.test(n)) return n.slice(0, 50); }
  }
  return '';
}
function parseNotif(title, text, app) {
  const texto = (String(title || '') + '\n' + String(text || '')).replace(/ /g, ' ');
  const bajo = texto.toLowerCase();
  const recibido = /recibiste|te enviaron|te han enviado|te llegaron|te lleg[oó]|transferencia recibida|has recibido|abono|dep[oó]sito|consignaci[oó]n|te transfirieron|nos enviaron|recepci[oó]n de (?:una )?transferencia|transferencia a tu cuenta|transferencia a su cuenta|ingreso de|te envi[oó]|te mand[oó]|te pag[oó]|te depositaron|plata|lleg[oó] plata/.test(bajo);
  const salida = /enviaste|pagaste|has enviado|retiro|d[eé]bito|compra en|pago de|cuota|clave din[aá]mica|código|codigo de verificaci|solicitud|te cobr|cobro/.test(bajo);
  if (!recibido || (salida && !/recibiste|te enviaron|te han enviado|has recibido|te envi[oó]|te mand[oó]/.test(bajo))) return null;
  const amount = montoDe(texto) || montoSinSigno(texto);
  if (!amount) return null;
  const f = (String(app || '') + ' ' + bajo);
  const bank = /nequi/.test(f) ? 'Nequi' : /daviplata/.test(f) ? 'Daviplata' : /bancolombia/.test(f) ? 'Bancolombia' : /davivienda/.test(f) ? 'Davivienda' : /bre-?b/.test(f) ? 'Bre-B' : /\bnu\b|nubank/.test(f) ? 'Nu' : clean(app, 30);
  return { amount, bank, payer: pagador(texto) };
}

module.exports = { getDb, money, clean, same, enabled, savePago, parseNotif };
