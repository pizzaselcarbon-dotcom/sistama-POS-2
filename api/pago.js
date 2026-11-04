// Recibe pagos detectados en el correo del banco (los envía el script de Google del Verificador).
// POST /api/pago  con cabecera  x-secret: <PAGOS_SECRET>
// body: { id, bank, amount, payer, subject, at }
// Guarda el pago en Firestore (pos_pagos) y avisa con push a los equipos del POS.
const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('crypto');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}
const money = n => '$' + Math.round(+n || 0).toLocaleString('es-CO');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const secret = process.env.PAGOS_SECRET;
  if (!secret || !process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(200).json({ ok: false, error: 'sin configurar' });
  if (!same(req.headers['x-secret'] || '', secret)) return res.status(401).json({ error: 'clave' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const id = String(b.id || '');
  const amount = Math.round(+b.amount);
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return res.status(400).json({ error: 'id' });
  if (!(amount > 0 && amount < 100000000)) return res.status(400).json({ error: 'monto' });
  const at = +b.at > 0 && +b.at <= Date.now() + 60000 ? Math.round(+b.at) : Date.now();
  const p = { bank: clean(b.bank, 30), amount, payer: clean(b.payer, 60), subject: clean(b.subject, 140), at, status: 'nuevo', createdAt: Date.now() };

  try {
    const db = getDb();
    try { await db.collection('pos_pagos').doc(id).create(p); }
    catch (e) { return res.status(200).json({ ok: true, dup: true }); }

    let sent = 0;
    if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE && Date.now() - at < 30 * 60 * 1000) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || ('https://' + (req.headers.host || 'localhost')), process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
      const payload = JSON.stringify({ title: '💰 Pago recibido ' + money(amount), body: [p.bank, p.payer].filter(Boolean).join(' · ') || 'Transferencia', tag: 'pago-recibido' });
      const subs = await db.collection('pos_push').get();
      await Promise.all(subs.docs.map(async d => {
        const s = d.data().sub;
        if (!s || !s.endpoint) return;
        try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); sent++; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete().catch(() => {}); }
      }));
    }
    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'servidor' });
  }
};
