const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '2222';
const adminSessions = new Set();
const databaseDirectory = path.join(__dirname, 'database');
const databasePath = path.join(databaseDirectory, 'barberia.db');

fs.mkdirSync(databaseDirectory, { recursive: true });

// Conexión a la base de datos con sqlite3
const db = new sqlite3.Database(databasePath);
function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS barberos (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL,
      especialidad TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL,
      precio INTEGER NOT NULL,
      duracion INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_nombre TEXT NOT NULL,
      cliente_whatsapp TEXT NOT NULL,
      servicio_id INTEGER,
      barbero_id INTEGER,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      FOREIGN KEY(servicio_id) REFERENCES servicios(id),
      FOREIGN KEY(barbero_id) REFERENCES barberos(id)
    )
  `);

  db.run("ALTER TABLE turnos ADD COLUMN estado TEXT NOT NULL DEFAULT 'confirmado'", () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS eventos_turno (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      turno_id INTEGER NOT NULL,
      cliente_nombre TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed inicial
  db.get('SELECT COUNT(*) AS total FROM barberos', [], (err, row) => {
    if (row && row.total === 0) {
      const stmt = db.prepare('INSERT INTO barberos (id, nombre, especialidad) VALUES (?, ?, ?)');
      [
        [1, 'Cristiano', 'Cortes y estilos'],
        [2, 'Di Lollo', 'El más vacilador'],
        [3, 'Máximo', 'El mejor en todo']
      ].forEach((barbero) => stmt.run(barbero));
      stmt.finalize();
    }
  });

  db.run("UPDATE barberos SET nombre = 'Cristiano', especialidad = 'Cortes y estilos' WHERE id = 1");
  db.run("UPDATE barberos SET nombre = 'Di Lollo', especialidad = 'El más vacilador' WHERE id = 2");
  db.run("UPDATE barberos SET nombre = 'Máximo', especialidad = 'El mejor en todo' WHERE id = 3");

  db.get('SELECT COUNT(*) AS total FROM servicios', [], (err, row) => {
    if (row && row.total === 0) {
      const stmt = db.prepare('INSERT INTO servicios (id, nombre, precio, duracion) VALUES (?, ?, ?, ?)');
      [
        [1, 'Corte Clásico', 8000, 30],
        [2, 'Corte + Barba', 12000, 60],
        [3, 'Afeitado Completo', 7000, 30]
      ].forEach((servicio) => stmt.run(servicio));
      stmt.finalize();
    }
  });
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.get('/favicon.svg', (req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'images', 'logo.jpg'), (error, logo) => {
    if (error) return res.status(404).end();
    const encodedLogo = logo.toString('base64');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><clipPath id="circle"><circle cx="64" cy="64" r="64"/></clipPath></defs><image href="data:image/jpeg;base64,${encodedLogo}" width="128" height="128" preserveAspectRatio="xMidYMid slice" clip-path="url(#circle)"/></svg>`);
  });
});
app.use(express.static(path.join(__dirname, 'public')));

function getAdminToken(req) {
  const cookies = (req.headers.cookie || '').split(';').map((cookie) => cookie.trim());
  const adminCookie = cookies.find((cookie) => cookie.startsWith('proa_admin='));
  return adminCookie ? adminCookie.slice('proa_admin='.length) : '';
}

function requireAdmin(req, res, next) {
  if (adminSessions.has(getAdminToken(req))) return next();
  res.status(401).json({ error: 'Acceso exclusivo para el barbero.' });
}

function isClosedDate(date) {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  return weekday === 0 || weekday === 1;
}

function isValidBookingSlot(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || isClosedDate(date)) return false;
  const [hour, minute] = time.split(':').map(Number);
  if (hour < 9 || hour > 20 || ![0, 30].includes(minute) || (hour === 20 && minute !== 0)) return false;
  const requested = new Date(`${date}T${time}:00`);
  return !Number.isNaN(requested.getTime()) && requested > new Date();
}

function isValidClientName(name) {
  return /^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u.test(String(name).trim());
}

function hoursUntilBooking(booking) {
  return (new Date(`${booking.fecha}T${booking.hora}:00`) - Date.now()) / 3600000;
}

function recordBookingEvent(type, booking, date = booking.fecha, time = booking.hora) {
  db.run(
    'INSERT INTO eventos_turno (tipo, turno_id, cliente_nombre, fecha, hora) VALUES (?, ?, ?, ?, ?)',
    [type, booking.id, booking.cliente_nombre, date, time],
    (error) => { if (error) console.error('No se pudo guardar el evento del turno:', error.message); }
  );
}

function dbGetAsync(query, params = []) {
  return new Promise((resolve, reject) => db.get(query, params, (error, row) => error ? reject(error) : resolve(row)));
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto.' });
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  adminSessions.add(token);
  res.setHeader('Set-Cookie', `proa_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  adminSessions.delete(getAdminToken(req));
  res.setHeader('Set-Cookie', 'proa_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/servicios', (req, res) => {
  db.all('SELECT * FROM servicios ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/barberos', (req, res) => {
  db.all('SELECT * FROM barberos ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/turnos', async (req, res) => {
  const hasFecha = Boolean(req.query.fecha);
  if (!hasFecha && !adminSessions.has(getAdminToken(req))) return res.status(401).json({ error: 'Acceso exclusivo para el barbero.' });
  const query = hasFecha ? `
    SELECT barbero_id, hora
    FROM turnos
    WHERE fecha = ? AND estado != 'cancelado'
    ORDER BY hora ASC
  ` : `
    SELECT turnos.*, servicios.nombre AS servicio_nombre, barberos.nombre AS barbero_nombre
    FROM turnos
    LEFT JOIN servicios ON servicios.id = turnos.servicio_id
    LEFT JOIN barberos ON barberos.id = turnos.barbero_id
    WHERE turnos.estado != 'cancelado'
    ORDER BY turnos.fecha ASC, turnos.hora ASC
  `;
  const params = hasFecha ? [req.query.fecha] : [];

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/admin/eventos/ultimo', requireAdmin, (req, res) => {
  db.get('SELECT COALESCE(MAX(id), 0) AS id FROM eventos_turno', [], (error, row) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(row);
  });
});

app.get('/api/admin/eventos', requireAdmin, (req, res) => {
  const afterId = Math.max(0, Number(req.query.despues) || 0);
  db.all('SELECT * FROM eventos_turno WHERE id > ? ORDER BY id ASC LIMIT 50', [afterId], (error, rows) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(rows);
  });
});

app.post('/api/turnos', async (req, res) => {
  const { cliente_nombre, cliente_whatsapp, servicio_id, barbero_id, fecha, hora } = req.body;
  if (!cliente_nombre || !cliente_whatsapp || !servicio_id || !barbero_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Completá todos los datos del turno.' });
  }
  if (!isValidClientName(cliente_nombre)) {
    return res.status(400).json({ error: 'El nombre solo puede contener letras.' });
  }
  if (!/^\d{10}$/.test(String(cliente_whatsapp))) {
    return res.status(400).json({ error: 'El WhatsApp debe tener exactamente 10 números.' });
  }
  if (!isValidBookingSlot(fecha, hora)) {
    return res.status(400).json({ error: 'Elegí un horario futuro entre las 09:00 y las 20:00, de martes a sábado.' });
  }

  try {
    const service = await dbGetAsync('SELECT * FROM servicios WHERE id = ?', [servicio_id]);
    if (!service) return res.status(400).json({ error: 'El servicio seleccionado no existe.' });
    const barber = await dbGetAsync('SELECT * FROM barberos WHERE id = ?', [barbero_id]);
    if (!barber) return res.status(400).json({ error: 'El barbero seleccionado no existe.' });
    const occupied = await dbGetAsync(
      "SELECT id FROM turnos WHERE barbero_id = ? AND fecha = ? AND hora = ? AND estado != 'cancelado'",
      [barbero_id, fecha, hora]
    );
    if (occupied) return res.status(400).json({ error: 'Ese horario ya fue reservado. Elegí otro.' });

    const insert = await dbRunAsync(
      `INSERT INTO turnos (cliente_nombre, cliente_whatsapp, servicio_id, barbero_id, fecha, hora, estado)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmado')`,
      [cliente_nombre.trim(), cliente_whatsapp.trim(), servicio_id, barbero_id, fecha, hora]
    );
    const booking = await dbGetAsync(
      `SELECT turnos.*, servicios.nombre AS servicio_nombre, barberos.nombre AS barbero_nombre
       FROM turnos LEFT JOIN servicios ON servicios.id = turnos.servicio_id
       LEFT JOIN barberos ON barberos.id = turnos.barbero_id WHERE turnos.id = ?`,
      [insert.lastID]
    );
    recordBookingEvent('turno_reservado', booking);
    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message || 'No se pudo guardar el turno.' });
  }
});

app.post('/api/turnos/cliente/buscar', async (req, res) => {
  const bookingId = Number(req.body.turno_id);
  const whatsapp = String(req.body.cliente_whatsapp || '');
  if (!Number.isInteger(bookingId) || bookingId < 1 || !/^\d{10}$/.test(whatsapp)) {
    return res.status(400).json({ error: 'Ingresá el número de reserva y el WhatsApp de 10 dígitos.' });
  }

  db.get(
    `SELECT turnos.*, servicios.nombre AS servicio_nombre, barberos.nombre AS barbero_nombre
     FROM turnos
     LEFT JOIN servicios ON servicios.id = turnos.servicio_id
     LEFT JOIN barberos ON barberos.id = turnos.barbero_id
     WHERE turnos.id = ? AND turnos.cliente_whatsapp = ?`,
    [bookingId, whatsapp],
    (error, booking) => {
      if (error) return res.status(500).json({ error: error.message });
      if (!booking) return res.status(404).json({ error: 'No encontramos una reserva con esos datos.' });
      res.json(booking);
    }
  );
});

app.patch('/api/turnos/:id/cliente', (req, res) => {
  const whatsapp = String(req.body.cliente_whatsapp || '');
  const { fecha, hora } = req.body;
  if (!/^\d{10}$/.test(whatsapp) || !fecha || !hora) {
    return res.status(400).json({ error: 'Revisá el WhatsApp, la fecha y el horario.' });
  }
  if (!isValidBookingSlot(fecha, hora)) {
    return res.status(400).json({ error: 'Elegí un horario futuro entre las 09:00 y las 20:00, de martes a sábado.' });
  }

  db.get('SELECT * FROM turnos WHERE id = ? AND cliente_whatsapp = ?', [req.params.id, whatsapp], (error, booking) => {
    if (error) return res.status(500).json({ error: error.message });
    if (!booking) return res.status(404).json({ error: 'No encontramos una reserva con esos datos.' });
    if (booking.estado === 'cancelado') return res.status(400).json({ error: 'Este turno ya está cancelado.' });
    if (hoursUntilBooking(booking) < 4) return res.status(400).json({ error: 'Podés cambiar el turno hasta 4 horas antes.' });

    db.get(
      "SELECT id FROM turnos WHERE barbero_id = ? AND fecha = ? AND hora = ? AND id != ? AND estado != 'cancelado'",
      [booking.barbero_id, fecha, hora, booking.id],
      (conflictError, occupied) => {
        if (conflictError) return res.status(500).json({ error: conflictError.message });
        if (occupied) return res.status(400).json({ error: 'Ese horario ya no está disponible. Elegí otro.' });

        db.run('UPDATE turnos SET fecha = ?, hora = ? WHERE id = ?', [fecha, hora, booking.id], function (updateError) {
          if (updateError) return res.status(500).json({ error: updateError.message });
          recordBookingEvent('turno_reprogramado', booking, fecha, hora);
          res.json({ ok: true });
        });
      }
    );
  });
});

app.delete('/api/turnos/:id/cliente', async (req, res) => {
  const whatsapp = String(req.body.cliente_whatsapp || '');
  if (!/^\d{10}$/.test(whatsapp)) {
    return res.status(400).json({ error: 'Ingresá el WhatsApp de 10 dígitos asociado a la reserva.' });
  }

  try {
    const booking = await dbGetAsync('SELECT * FROM turnos WHERE id = ? AND cliente_whatsapp = ?', [req.params.id, whatsapp]);
    if (!booking || booking.estado === 'cancelado') return res.status(404).json({ error: 'No encontramos una reserva activa con esos datos.' });
    if (hoursUntilBooking(booking) < 4) return res.status(400).json({ error: 'Podés cancelar el turno hasta 4 horas antes.' });
    const update = await dbRunAsync("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND estado != 'cancelado'", [booking.id]);
    if (!update.changes) return res.status(404).json({ error: 'El turno ya fue cancelado.' });
    recordBookingEvent('turno_eliminado', booking);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/turnos/:id', requireAdmin, (req, res) => {
  const { cliente_nombre, cliente_whatsapp, servicio_id, barbero_id, fecha, hora } = req.body;
  if (!cliente_nombre || !cliente_whatsapp || !servicio_id || !barbero_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Completá todos los datos del turno.' });
  }
  if (!isValidClientName(cliente_nombre)) {
    return res.status(400).json({ error: 'El nombre solo puede contener letras.' });
  }
  if (!/^\d{10}$/.test(String(cliente_whatsapp))) {
    return res.status(400).json({ error: 'El WhatsApp debe tener exactamente 10 números.' });
  }
  if (!isValidBookingSlot(fecha, hora)) {
    return res.status(400).json({ error: 'Elegí un horario futuro entre las 09:00 y las 20:00, de martes a sábado.' });
  }

  db.get('SELECT id FROM servicios WHERE id = ?', [servicio_id], (serviceError, servicio) => {
    if (serviceError) return res.status(500).json({ error: serviceError.message });
    if (!servicio) return res.status(400).json({ error: 'El servicio seleccionado no existe.' });

    db.get('SELECT id FROM barberos WHERE id = ?', [barbero_id], (barberError, barbero) => {
      if (barberError) return res.status(500).json({ error: barberError.message });
      if (!barbero) return res.status(400).json({ error: 'El barbero seleccionado no existe.' });

      db.get(
        'SELECT id FROM turnos WHERE barbero_id = ? AND fecha = ? AND hora = ? AND id != ?',
        [barbero_id, fecha, hora, req.params.id],
        (conflictError, ocupado) => {
          if (conflictError) return res.status(500).json({ error: conflictError.message });
          if (ocupado) return res.status(400).json({ error: 'Ese horario ya fue reservado. Elegí otro.' });

          db.run(
            `UPDATE turnos SET cliente_nombre = ?, cliente_whatsapp = ?, servicio_id = ?, barbero_id = ?, fecha = ?, hora = ? WHERE id = ?`,
            [cliente_nombre.trim(), cliente_whatsapp.trim(), servicio_id, barbero_id, fecha, hora, req.params.id],
            function (updateError) {
              if (updateError) return res.status(500).json({ error: updateError.message });
              if (this.changes === 0) return res.status(404).json({ error: 'Turno no encontrado.' });
              recordBookingEvent('turno_reprogramado', { id: Number(req.params.id), cliente_nombre: cliente_nombre.trim(), fecha, hora });
              res.json({ ok: true });
            }
          );
        }
      );
    });
  });
});

app.post('/api/servicios', requireAdmin, (req, res) => {
  const { nombre, precio, duracion } = req.body;
  if (!nombre || !Number.isFinite(Number(precio)) || Number(precio) < 0 || !Number.isFinite(Number(duracion)) || Number(duracion) <= 0) {
    return res.status(400).json({ error: 'Ingresá nombre, precio y duración válidos.' });
  }
  db.run(
    'INSERT INTO servicios (nombre, precio, duracion) VALUES (?, ?, ?)',
    [nombre.trim(), Number(precio), Number(duracion)],
    function (error) {
      if (error) return res.status(500).json({ error: error.message });
      res.status(201).json({ id: this.lastID, nombre: nombre.trim(), precio: Number(precio), duracion: Number(duracion) });
    }
  );
});

app.patch('/api/servicios/:id', requireAdmin, (req, res) => {
  const { nombre, precio, duracion } = req.body;
  if (!nombre || !Number.isFinite(Number(precio)) || Number(precio) < 0 || !Number.isFinite(Number(duracion)) || Number(duracion) <= 0) {
    return res.status(400).json({ error: 'Ingresá nombre, precio y duración válidos.' });
  }
  db.run(
    'UPDATE servicios SET nombre = ?, precio = ?, duracion = ? WHERE id = ?',
    [nombre.trim(), Number(precio), Number(duracion), req.params.id],
    function (error) {
      if (error) return res.status(500).json({ error: error.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Servicio no encontrado.' });
      res.json({ ok: true });
    }
  );
});

app.delete('/api/servicios/:id', requireAdmin, (req, res) => {
  db.get('SELECT id FROM turnos WHERE servicio_id = ? LIMIT 1', [req.params.id], (checkError, turno) => {
    if (checkError) return res.status(500).json({ error: checkError.message });
    if (turno) return res.status(400).json({ error: 'No podés borrar un servicio que tiene turnos asociados.' });
    db.run('DELETE FROM servicios WHERE id = ?', [req.params.id], function (error) {
      if (error) return res.status(500).json({ error: error.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Servicio no encontrado.' });
      res.json({ ok: true });
    });
  });
});

app.delete('/api/turnos/:id', requireAdmin, async (req, res) => {
  try {
    const booking = await dbGetAsync('SELECT * FROM turnos WHERE id = ?', [req.params.id]);
    if (!booking) return res.status(404).json({ error: 'Turno no encontrado.' });
    const deletion = await dbRunAsync('DELETE FROM turnos WHERE id = ?', [req.params.id]);
    if (!deletion.changes) return res.status(404).json({ error: 'Turno no encontrado.' });
    recordBookingEvent('turno_cancelado', booking);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PROA AL FILO corriendo en http://localhost:${PORT}`);
});