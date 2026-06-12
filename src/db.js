const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'accounts.db');
let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);

        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                username TEXT DEFAULT '',
                password TEXT DEFAULT '',
                shared_secret TEXT DEFAULT '',
                identity_secret TEXT DEFAULT '',
                farm_game_ids TEXT DEFAULT '730',
                login_method TEXT DEFAULT 'credentials',
                refresh_token TEXT DEFAULT '',
                auto_confirm INTEGER DEFAULT 0,
                enabled INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
        `);

        // Migrate: add owner_id if missing (for existing DBs)
        try { db.exec('ALTER TABLE accounts ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE'); } catch (e) {}
    }
    return db;
}

// ── Users ────────────────────────────────────────────────

module.exports = {
    listUsers() {
        return getDb().prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
    },
    getUser(id) {
        return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    },
    getUserByUsername(username) {
        return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    },
    createUser({ username, password_hash, role = 'user' }) {
        return getDb()
            .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
            .run(username, password_hash, role)
            .lastInsertRowid;
    },
    updateUser(id, data) {
        const allowed = ['username', 'password_hash', 'role'];
        const fields = Object.keys(data).filter(k => allowed.includes(k) && data[k] !== undefined);
        if (fields.length === 0) return;
        getDb().prepare(`UPDATE users SET ${fields.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
            .run(...fields.map(k => data[k]), id);
    },
    deleteUser(id) {
        getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    countUsers() {
        return getDb().prepare('SELECT COUNT(*) as n FROM users').get().n;
    },

    // ── Accounts ────────────────────────────────────────────

    listAccounts({ ownerId = null } = {}) {
        if (ownerId) {
            return getDb()
                .prepare('SELECT id, owner_id, label, username, login_method, farm_game_ids, enabled, created_at FROM accounts WHERE owner_id = ? ORDER BY id')
                .all(ownerId);
        }
        return getDb()
            .prepare('SELECT id, owner_id, label, username, login_method, farm_game_ids, enabled, created_at FROM accounts ORDER BY id')
            .all();
    },
    getAccount(id) {
        return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    },
    getAccountForUser(id, ownerId) {
        return getDb().prepare('SELECT * FROM accounts WHERE id = ? AND owner_id = ?').get(id, ownerId);
    },
    createAccount({ owner_id, label, username = '', password = '', shared_secret = '', identity_secret = '', farm_game_ids = '730', login_method = 'credentials', auto_confirm = 0 }) {
        return getDb()
            .prepare('INSERT INTO accounts (owner_id, label, username, password, shared_secret, identity_secret, farm_game_ids, login_method, auto_confirm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(owner_id || null, label, username, password, shared_secret, identity_secret, farm_game_ids, login_method, auto_confirm ? 1 : 0)
            .lastInsertRowid;
    },
    updateAccount(id, data) {
        const allowed = ['label', 'username', 'password', 'shared_secret', 'identity_secret', 'farm_game_ids', 'login_method', 'refresh_token', 'auto_confirm', 'enabled', 'owner_id'];
        const fields = Object.keys(data).filter(k => allowed.includes(k) && data[k] !== undefined);
        if (fields.length === 0) return;
        getDb().prepare(`UPDATE accounts SET ${fields.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
            .run(...fields.map(k => data[k]), id);
    },
    deleteAccount(id) {
        getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
    },
};
