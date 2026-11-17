// Recibe pagos detectados en el correo del banco (los envía el script de Google del Verificador).
// POST /api/pago  con cabecera  x-secret: <PAGOS_SECRET>
// body: { id, bank, amount, payer, subject, at }
// Guarda el pago en Firestore (pos_pagos) y avisa con push a los equipos del POS.
// Si el método «Correo» está desactivado en el POS (Verificador), el pago se ignora.
const { getDb, clean, same, enabled, savePago } = require('./_pagos');

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
  const p = { bank: clean(b.bank, 30), amount, payer: clean(b.payer, 60), subject: clean(b.subject, 140), at, status: 'nuevo', createdAt: Date.now(), src: 'correo' };

  try {
    const db = getDb();
    if (!(await enabled(db, 'correo'))) return res.status(200).json({ ok: true, off: true });
    return res.status(200).json(await savePago(db, id, p, req.headers.host));
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'servidor' });
  }
};
