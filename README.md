# PROA AL FILO

Aplicación full stack de reservas para una barbería premium, con frontend en HTML/Tailwind/JavaScript, backend en Node.js + Express y persistencia en SQLite.

## Requisitos

- Node.js 18 o superior
- npm

## Cómo correrlo

```bash
npm install
npm start
```

Abrí [http://localhost:3000](http://localhost:3000) en el navegador.

La base de datos se crea automáticamente en `database/barberia.db` junto con las tablas y los datos iniciales de barberos y servicios.

## API

- `GET /api/servicios`
- `GET /api/barberos`
- `GET /api/turnos`
- `GET /api/turnos?fecha=AAAA-MM-DD`
- `POST /api/turnos`
- `DELETE /api/turnos/:id`
- `POST /api/turnos/cliente/buscar` (reserva y WhatsApp)
- `PATCH /api/turnos/:id/cliente` (reprogramar con WhatsApp)
- `DELETE /api/turnos/:id/cliente` (cancelar con WhatsApp)
- `POST /api/pagos/verificar` (verifica retorno de Checkout Pro)
- `POST /api/mercadopago/webhook` (notificaciones firmadas de pago)
- `GET /api/admin/eventos` (feed de avisos autenticado)

Los clientes pueden gestionar su turno desde `Mi turno` usando el número de reserva y el WhatsApp asociado. El comprobante de reserva incluye el número. Los turnos solo se pueden tomar de martes a sábado, entre las 09:00 y las 20:00.

## Señas y avisos

La seña es el 20 % del servicio. Se permite cancelar o reprogramar hasta 4 horas antes; si se cancela una reserva con seña pagada dentro del plazo, el importe queda como crédito asociado al WhatsApp para la próxima reserva. Los checkouts sin completar vencen a los 20 minutos y liberan el horario. El panel del barbero muestra avisos de reservas, pagos, cambios y cancelaciones; puede activar también notificaciones del navegador.

Para cobrar de verdad, copiá `.env.example` como `.env` y completá las credenciales de Mercado Pago. No compartas ni subas `.env`:

```env
MP_ACCESS_TOKEN=APP_USR-...
MP_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://tu-dominio-publico
MP_WEBHOOK_URL=https://tu-dominio-publico/api/mercadopago/webhook
```

`PUBLIC_BASE_URL` y el webhook deben apuntar a un servidor público HTTPS; Mercado Pago no puede notificar a `localhost`. Configurá en Mercado Pago el webhook de pagos con la misma URL y copiá su clave de firma a `MP_WEBHOOK_SECRET`. Luego reiniciá con `npm start`. Sin `MP_ACCESS_TOKEN`, la app lo informa y guarda las reservas sin cobrar seña. Las credenciales reales no están incluidas y el checkout real no se puede probar hasta configurarlas.

## Acceso del barbero

El panel administrativo se abre desde `Acceso barbero` en el pie de página. El PIN predeterminado es `2222`; para cambiarlo, iniciá el servidor con la variable `ADMIN_PIN` definida. Las rutas administrativas para listar y cancelar turnos requieren autenticación.
