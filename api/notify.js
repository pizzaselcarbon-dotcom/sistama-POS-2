// Envía un aviso push a los equipos del POS cuando entra un pedido nuevo.
// GET  /api/notify            -> { key: <clave pública VAPID> }  (el POS la usa para activar avisos)
// POST /api/notify {id}       -> lee el pedido en Firestore y avisa a los equipos registrados
const admin = require('firebase-admin');
const webpush = require('web-push');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}
const money = n => '$' + Math.round(+n || 0).toLocaleString('es-CO');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function message(o) {
  const nm = clean(o.name, 40), tb = clean(o.table, 40), tot = money(o.total);
  if (o.pay === 'mesera-mod') return { title: '✏️ Modificación de mesera', body: `${tb}${nm ? ' · ' + nm : ''}` };
  if (o.pay === 'mesera') return { title: '🧑‍🍳 Pedido de mesera', body: `${tb}${nm ? ' · ' + nm : ''} · ${tot}` };
  if (o.type === 'domicilio') return { title: '🛵 Pedido a domicilio', body: `${nm || 'Cliente'}${tb ? ' · ' + tb : ''} · ${tot}` };
  if (tb === 'Para recoger') return { title: '🏪 Pedido para recoger', body: `${nm || 'Cliente'} · ${tot}` };
  return { title: '🌐 Pedido nuevo', body: `${tb}${nm ? ' · ' + nm : ''} · ${tot}` };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ key: process.env.VAPID_PUBLIC || '' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = String((body && body.id) || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: 'id' });
  if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    return res.status(200).json({ ok: false, error: 'sin configurar' });
  }
  try {
    const db = getDb();
    const snap = await db.collection('orders').doc(id).get();
    if (!snap.exists) return res.status(200).json({ ok: false, error: 'no existe' });
    const o = snap.data();
    if (o.status !== 'new') return res.status(200).json({ ok: false, error: 'ya atendido' });
    const ts = o.createdAt && o.createdAt.toMillis ? o.createdAt.toMillis() : 0;
    if (ts && Date.now() - ts > 15 * 60 * 1000) return res.status(200).json({ ok: false, error: 'viejo' });
    try { await db.collection('push_sent').doc(id).create({ at: Date.now() }); }
    catch (e) { return res.status(200).json({ ok: true, dup: true }); }

    webpush.setVapidDetails(process.env.VAPID_SUBJECT || ('https://' + (req.headers.host || 'localhost')), process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
    const payload = JSON.stringify({ ...message(o), tag: 'pedido-online' });
    const subs = await db.collection('pos_push').get();
    let sent = 0, gone = 0;
    await Promise.all(subs.docs.map(async d => {
      const s = d.data().sub;
      if (!s || !s.endpoint) return;
      try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { gone++; await d.ref.delete().catch(() => {}); } }
    }));
    return res.status(200).json({ ok: true, sent, gone });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 120) });
  }
};
