// Recibe el texto de una notificación del celular Android (MacroDroid, Tasker...) cuando llega un pago.
// POST (o GET) /api/notif?k=<PAGOS_SECRET>      (también sirve la cabecera x-secret)
// Cuerpo: texto plano con el título y el texto de la notificación, o JSON { title, text, app, at }.
const crypto = require('crypto');
const { getDb, clean, same, enabled, savePago, parseNotif } = require('./_pagos');

const BUCKET = 45000; // ventana para no guardar dos veces la misma notificación

module.exports = async (req, res) => {
  const secret = process.env.PAGOS_SECRET;
  if (!secret || !process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(200).json({ ok: false, error: 'sin configurar' });
  const q = req.query || {};
  if (!same(req.headers['x-secret'] || q.k || '', secret)) return res.status(401).json({ error: 'clave' });

  let b = req.body, title = '', text = '', app = '', at = 0;
  if (typeof b === 'string') { try { const j = JSON.parse(b); b = j && typeof j === 'object' ? j : null; } catch (e) { text = b; b = null; } }
  if (b && typeof b === 'object') {
    title = b.title || ''; text = b.text || b.message || b.body || b.notification || ''; app = b.app || ''; at = +b.at || 0;
    if (!title && !text) text = Object.entries(b).map(([k, v]) => (v ? k + ' ' + v : k)).join(' '); // formulario mal armado: se lee igual
  }
  title = title || q.title || ''; text = text || q.text || ''; app = app || q.app || '';
  const full = clean(title + ' ' + text, 400);
  if (!full) return res.status(400).json({ error: 'sin texto' });

  try {
    const db = getDb();
    if (!(await enabled(db, 'notif'))) return res.status(200).json({ ok: true, off: true });
    const now = Date.now(), when = at > 0 && Math.abs(now - at) < 10 * 60 * 1000 ? Math.round(at) : now;
    const r = parseNotif(title, text, app);
    let result = 'ignorada', sent = 0;
    if (r) {
      const bucket = Math.floor(when / BUCKET), hid = n => 'n' + crypto.createHash('sha1').update(full.toLowerCase() + '|' + n).digest('hex').slice(0, 24);
      const p = { bank: r.bank, amount: r.amount, payer: r.payer, subject: clean(full, 140), at: when, status: 'nuevo', createdAt: now, src: 'notif' };
      const s = await savePago(db, hid(bucket), p, req.headers.host, [hid(bucket - 1)]);
      result = s.dup ? 'repetida' : 'pago'; sent = s.sent || 0;
    }
    // registro de lo que llega, para verlo en el POS (se conservan las últimas 40)
    try {
      await db.collection('pos_notiflog').add({ at: now, app: clean(app, 30), text: full, amount: r ? r.amount : 0, res: result });
      const old = await db.collection('pos_notiflog').orderBy('at', 'desc').offset(40).limit(30).get();
      await Promise.all(old.docs.map(d => d.ref.delete()));
    } catch (e) {}
    return res.status(200).json({ ok: true, res: result, sent });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'servidor' });
  }
};
