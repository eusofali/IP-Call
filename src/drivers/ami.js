// Minimal Asterisk Manager Interface client, used only to read outbound registration status
// (ARI does not expose it, and the endpoint state is "offline" whenever the operator ignores OPTIONS pings).
const net = require('net');
const cfg = require('../config');

function parseBlock(block) {
  const o = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

/** Returns Map(registrationName -> status) e.g. "trunk3-reg" -> "Registered" | "Unregistered" | "Rejected" | "Stopped". */
function outboundRegistrations({ host, port, user, pass } = cfg.ami, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!user || !pass) return reject(new Error('AMI not configured'));
    const sock = net.connect({ host, port });
    const result = new Map();
    let buf = '', loggedIn = false, done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.end('Action: Logoff\r\n\r\n'); } catch { /* ignore */ }
      sock.destroy();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('AMI timeout')), timeoutMs);
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => sock.write(`Action: Login\r\nUsername: ${user}\r\nSecret: ${pass}\r\nEvents: off\r\n\r\n`));
    sock.on('data', (d) => {
      buf += d.toString();
      buf = buf.replace(/^Asterisk Call Manager\/[^\r\n]*\r\n/, '');
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) !== -1) {
        const m = parseBlock(buf.slice(0, i));
        buf = buf.slice(i + 4);
        if (!loggedIn) {
          if (m.Response !== 'Success') return finish(new Error('AMI login failed: ' + (m.Message || 'unknown')));
          loggedIn = true;
          sock.write('Action: PJSIPShowRegistrationsOutbound\r\nActionID: ipc\r\n\r\n');
        } else if (m.Response === 'Error') {
          return finish(); // "No elements found" when there are no registrations
        } else if (m.Event === 'OutboundRegistrationDetail') {
          result.set(m.ObjectName, m.Status);
        } else if (m.Event === 'OutboundRegistrationDetailComplete') {
          return finish();
        }
      }
    });
  });
}

module.exports = { outboundRegistrations };
