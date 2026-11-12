// SQLite driver selection.
// Prefers better-sqlite3 (fast, native). Falls back to Node's built-in node:sqlite (Node >= 22.5)
// so the panel still runs on shared hosting where native modules cannot be compiled.
function open(file) {
  const want = process.env.SQLITE_DRIVER; // 'better' | 'node' | unset (auto)
  if (want !== 'node') {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(file);
      db.driverName = 'better-sqlite3';
      return db;
    } catch (e) {
      if (want === 'better') throw e;
      console.warn(`[db] better-sqlite3 unavailable (${e.code || e.message.split('\n')[0]}); trying node:sqlite`);
    }
  }
  let DatabaseSync;
  try {
    process.removeAllListeners('warning'); // silence "SQLite is experimental"
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('No SQLite driver: install better-sqlite3 (npm install) or use Node.js >= 22.5');
  }
  const raw = new DatabaseSync(file);
  // Small compatibility layer giving node:sqlite the parts of the better-sqlite3 API this app uses.
  const db = {
    driverName: 'node:sqlite',
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    pragma: (p) => raw.exec(`PRAGMA ${p}`),
    close: () => raw.close(),
    _depth: 0,
    transaction(fn) {
      return (...args) => {
        const depth = ++db._depth;
        const sp = `sp${depth}`;
        raw.exec(depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
        try {
          const r = fn(...args);
          raw.exec(depth === 1 ? 'COMMIT' : `RELEASE ${sp}`);
          return r;
        } catch (e) {
          raw.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
          throw e;
        } finally { db._depth--; }
      };
    },
  };
  return db;
}
module.exports = { open };
