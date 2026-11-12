// Audio file helpers: duration detection and copying/converting files for Asterisk.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('../config');

const uploadsDir = path.join(cfg.dataDir, 'uploads');
const filePath = (vf) => path.join(uploadsDir, vf.filename);

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Read duration of a PCM WAV from its header (no external tools needed). */
function wavDuration(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, byteRate = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data' && byteRate) return Math.round((size / byteRate) * 10) / 10;
      off += 8 + size + (size % 2);
    }
  } catch { /* ignore */ }
  return null;
}

async function probeDuration(file) {
  const w = wavDuration(file);
  if (w != null) return w;
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const n = out ? parseFloat(out) : NaN;
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

const crypto = require('crypto');
const mediaSig = (vfId) => crypto.createHmac('sha256', require('../db').getSetting('session_secret') || 'x')
  .update('vf' + vfId).digest('hex').slice(0, 24);

/**
 * Media URI Asterisk plays for a voice file.
 *  - Asterisk on the same server (sounds dir set): sound:/var/lib/asterisk/sounds/ipcall/vf<ID>
 *  - Asterisk on another server (e.g. panel on cPanel): a signed HTTPS URL to this panel
 *    (needs Asterisk 18+ with res_http_media_cache; upload WAV 8kHz mono if ffmpeg is unavailable).
 */
function asteriskMedia(vfId) {
  // Absolute path (no extension): works whatever Asterisk's own sounds directory is.
  if (cfg.asterisk.soundsDir) return `sound:${cfg.asterisk.soundsDir.replace(/\/+$/, '')}/vf${vfId}`;
  if (!cfg.publicUrl) return `sound:ipcall/vf${vfId}`;
  return `sound:${cfg.publicUrl}/media/vf${vfId}-${mediaSig(vfId)}.wav`;
}

/**
 * Put a copy of the file in Asterisk's sounds dir as 8kHz mono WAV.
 * Needs ASTERISK_SOUNDS_DIR (pointing at .../sounds/ipcall) and ffmpeg for non-WAV input.
 */
const remoteWav = (vf) => path.join(uploadsDir, `vf${vf.id}.8k.wav`);

async function prepareForAsterisk(vf) {
  const dir = cfg.asterisk.soundsDir || uploadsDir;
  fs.mkdirSync(dir, { recursive: true });
  const out = cfg.asterisk.soundsDir ? path.join(dir, `vf${vf.id}.wav`) : remoteWav(vf);
  const ok = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', filePath(vf), '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', out]);
  if (ok !== null) return true;
  if (/\.wav$/i.test(vf.filename)) { fs.copyFileSync(filePath(vf), out); return true; }
  return false;
}

function removeFiles(vf) {
  for (const f of [filePath(vf), remoteWav(vf), cfg.asterisk.soundsDir && path.join(cfg.asterisk.soundsDir, `vf${vf.id}.wav`)]) {
    if (f) fs.rm(f, { force: true }, () => {});
  }
}

module.exports = { remoteWav, mediaSig, uploadsDir, filePath, probeDuration, asteriskMedia, prepareForAsterisk, removeFiles };
