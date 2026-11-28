/**
 * BackStreet POS: receives the nightly backup from the POS (Railway) and saves it in this
 * Google Drive, in the folder "BackStreet POS backups (Railway)".
 *
 * What it can do:
 *   - ADD a backup file (flo-backup-....db.gz) to its own folder, only with the right key.
 *   - Move its own old nightly copies to the Bin: keeps the newest 30 nights plus the 1st of
 *     every month. Nothing else in the Drive is touched.
 * What it can NOT do: read, list, download or send back any file. It only answers ok / not ok.
 *
 * Setup (once):
 *   1. Project Settings (gear) → Script properties → Add: BACKUP_KEY = the same key as
 *      BACKUP_DRIVE_KEY in Railway (at least 32 characters). Never put the key in this file.
 *   2. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *   3. Copy the Web app URL (ends in /exec) into Railway as BACKUP_DRIVE_URL.
 */

var FOLDER_NAME = 'BackStreet POS backups (Railway)';
var NAME_RE = /^flo-backup-[A-Za-z0-9_.-]{1,120}\.db\.gz$/;
var NIGHTLY_RE = /^flo-backup-nightly-(\d{4}-\d{2})-(\d{2})\.db\.gz$/;
var KEEP_NIGHTS = 30;
var MAX_BYTES = 45 * 1024 * 1024;

function doPost(e) {
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    var key = PropertiesService.getScriptProperties().getProperty('BACKUP_KEY') || '';
    if (key.length < 32) return reply_({ ok: false, error: 'BACKUP_KEY is not set in Script properties' });
    if (!sameText_(String(body.key || ''), key)) return reply_({ ok: false, error: 'wrong key' });

    var name = String(body.name || '');
    if (!NAME_RE.test(name) || name.indexOf('..') >= 0) return reply_({ ok: false, error: 'bad file name' });
    var bytes = Utilities.base64Decode(String(body.data || ''));
    if (bytes.length < 20 || bytes.length > MAX_BYTES) return reply_({ ok: false, error: 'bad file size' });
    var digest = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
    if (digest !== String(body.sha256 || '')) return reply_({ ok: false, error: 'file damaged on the way' });

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var folder = backupFolder_();
      var saved = folder.createFile(Utilities.newBlob(bytes, 'application/gzip', name));
      // The new copy is safe: now bin an older copy with the same name and old nightlies.
      var same = folder.getFilesByName(name);
      while (same.hasNext()) {
        var f = same.next();
        if (f.getId() !== saved.getId()) f.setTrashed(true);
      }
      tidy_(folder);
    } finally {
      lock.releaseLock();
    }
    return reply_({ ok: true, name: name, size: bytes.length });
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Opening the link in a browser only shows that the script is running. */
function doGet() {
  return reply_({ ok: true, service: 'BackStreet POS backups' });
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      var saved = DriveApp.getFolderById(id);
      if (!saved.isTrashed()) return saved;
    } catch (ignored) { /* deleted: find or make it again */ }
  }
  var found = DriveApp.getFoldersByName(FOLDER_NAME);
  var folder = null;
  while (found.hasNext()) {
    var candidate = found.next();
    if (!candidate.isTrashed()) { folder = candidate; break; }
  }
  if (!folder) folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

/** Nightly copies (by name) to move to the Bin: older than the newest 30, except the 1st of a month. */
function nightliesToRemove_(names) {
  var nightly = [];
  for (var i = 0; i < names.length; i++) if (NIGHTLY_RE.test(names[i])) nightly.push(names[i]);
  nightly.sort();
  nightly.reverse();
  var remove = [];
  for (var j = KEEP_NIGHTS; j < nightly.length; j++) {
    var m = NIGHTLY_RE.exec(nightly[j]);
    if (m && m[2] !== '01') remove.push(nightly[j]);
  }
  return remove;
}

function tidy_(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  var names = [];
  for (var i = 0; i < files.length; i++) names.push(files[i].getName());
  var remove = nightliesToRemove_(names);
  for (var j = 0; j < files.length; j++) {
    if (remove.indexOf(files[j].getName()) >= 0) files[j].setTrashed(true);
  }
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
