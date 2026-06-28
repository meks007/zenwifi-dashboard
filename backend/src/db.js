'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DB_DIR, 'clients.db');

// Ensure the data directory exists (useful for local dev without a volume).
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS client_seen (
    mac             TEXT PRIMARY KEY,
    first_seen      TEXT NOT NULL,
    last_ping_at    TEXT,
    last_ping_result TEXT
  )
`);

// Migrate existing tables that predate the last_ping columns.
const cols = db.prepare("PRAGMA table_info(client_seen)").all().map(function(r) { return r.name; });
if (!cols.includes('last_ping_at')) {
  db.exec('ALTER TABLE client_seen ADD COLUMN last_ping_at TEXT');
}
if (!cols.includes('last_ping_result')) {
  db.exec('ALTER TABLE client_seen ADD COLUMN last_ping_result TEXT');
}

/**
 * Returns the ISO first_seen string for a MAC, or null if not found.
 */
function getFirstSeen(mac) {
  const row = db.prepare('SELECT first_seen FROM client_seen WHERE mac = ?').get(mac);
  return row ? row.first_seen : null;
}

/**
 * Inserts or replaces the first_seen timestamp for a MAC.
 */
function setFirstSeen(mac, isoTimestamp) {
  db.prepare('INSERT OR REPLACE INTO client_seen (mac, first_seen) VALUES (?, ?)').run(mac, isoTimestamp);
}

/**
 * Removes the first_seen record for a MAC (client went offline).
 */
function deleteFirstSeen(mac) {
  db.prepare('DELETE FROM client_seen WHERE mac = ?').run(mac);
}

/**
 * Returns all stored records as a Map<mac, isoTimestamp>.
 * Used on startup to pre-load timestamps for clients that are already online.
 */
function loadAll() {
  const rows = db.prepare('SELECT mac, first_seen FROM client_seen').all();
  const map  = new Map();
  rows.forEach(function(row) { map.set(row.mac, row.first_seen); });
  return map;
}

/**
 * Returns { last_ping_at, last_ping_result } for a MAC, or null if not found.
 * last_ping_result is a string like "3/3" or "1/3".
 */
function getLastPing(mac) {
  const row = db.prepare('SELECT last_ping_at, last_ping_result FROM client_seen WHERE mac = ?').get(mac);
  if (!row || !row.last_ping_at) return null;
  return { last_ping_at: row.last_ping_at, last_ping_result: row.last_ping_result };
}

/**
 * Persists the last ping timestamp and result for a MAC.
 * Uses INSERT OR REPLACE so it works even if first_seen was never written.
 */
function setLastPing(mac, isoTimestamp, resultStr) {
  db.prepare(`
    INSERT INTO client_seen (mac, first_seen, last_ping_at, last_ping_result)
    VALUES (?, COALESCE((SELECT first_seen FROM client_seen WHERE mac = ?), ?), ?, ?)
    ON CONFLICT(mac) DO UPDATE SET
      last_ping_at     = excluded.last_ping_at,
      last_ping_result = excluded.last_ping_result
  `).run(mac, mac, isoTimestamp, isoTimestamp, resultStr);
}

module.exports = { getFirstSeen, setFirstSeen, deleteFirstSeen, loadAll, getLastPing, setLastPing };
