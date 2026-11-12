// Entry point. Works with `node server.js`, PM2/systemd (VPS) and Phusion Passenger (cPanel "Setup Node.js App").
const cfg = require('./src/config');
const { Engine } = require('./src/engine');
const { createDriver } = require('./src/drivers');
const { createApp } = require('./src/app');
const { db } = require('./src/db');

const engine = new Engine(createDriver());
engine.start();
const app = createApp(engine);

const port = process.env.PORT || cfg.port; // Passenger provides its own PORT/socket
const server = app.listen(port, () => {
  console.log(`[http] ${cfg.appName} listening on ${typeof port === 'number' || /^\d+$/.test(port) ? 'http://localhost:' + port : port}`);
  console.log(`[db] using ${db.driverName}`);
});

function shutdown() {
  console.log('Shutting down...');
  engine.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
