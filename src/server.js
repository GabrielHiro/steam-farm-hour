const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const manager = require('./manager');

const CONFIG_FILE = path.resolve(process.cwd(), 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}

const PORT = Number(config.port || 3000);
const JWT_SECRET = config.jwt_secret || 'change-this-jwt-secret-' + Math.random().toString(36);

// ── Auth helpers ──────────────────────────────────────────

function signToken(user) {
    return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'token inválido ou expirado' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'acesso negado' });
    next();
}

// Check if a user can access an account (admin = all, user = own)
function canAccessAccount(user, account) {
    if (!account) return false;
    if (user.role === 'admin') return true;
    return account.owner_id === user.id;
}

// ── App setup ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Map(); // token -> ws

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user;
    try { user = jwt.verify(token, JWT_SECRET); } catch (e) { ws.close(1008, 'Unauthorized'); return; }

    wsClients.set(ws, user);
    ws.send(JSON.stringify({ type: 'hello', statuses: getStatusesForUser(user) }));
    ws.on('close', () => wsClients.delete(ws));
});

function getStatusesForUser(user) {
    const all = manager.getAllStatuses();
    if (user.role === 'admin') return all;
    const accounts = db.listAccounts({ ownerId: user.id });
    const allowed = new Set(accounts.map(a => a.id));
    return Object.fromEntries(Object.entries(all).filter(([id]) => allowed.has(Number(id))));
}

function broadcast(accountId, msg) {
    const account = db.getAccount(accountId);
    const data = JSON.stringify({ accountId, ...msg });
    for (const [ws, user] of wsClients) {
        if (!canAccessAccount(user, account)) continue;
        if (ws.readyState === 1) ws.send(data);
    }
}

manager.setOnMessage((accountId, msg) => broadcast(accountId, msg));

// ── Auth routes ───────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password obrigatórios' });
    const user = db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'credenciais inválidas' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'credenciais inválidas' });
    res.json({ token: signToken(user), role: user.role, username: user.username });
});

// ── User management (admin only) ──────────────────────────

app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
    res.json(db.listUsers());
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username e password obrigatórios' });
    if (db.getUserByUsername(username)) return res.status(409).json({ error: 'username já existe' });
    const password_hash = await bcrypt.hash(password, 10);
    const id = db.createUser({ username, password_hash, role: role === 'admin' ? 'admin' : 'user' });
    res.json({ id });
});

app.put('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    const { username, password, role } = req.body || {};
    const data = {};
    if (username) data.username = username;
    if (password) data.password_hash = await bcrypt.hash(password, 10);
    if (role) data.role = role === 'admin' ? 'admin' : 'user';
    db.updateUser(id, data);
    res.json({ ok: true });
});

app.delete('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'não pode deletar a si mesmo' });
    db.deleteUser(id);
    res.json({ ok: true });
});

// ── Accounts ──────────────────────────────────────────────

app.get('/api/accounts', authMiddleware, (req, res) => {
    const opts = req.user.role === 'admin' ? {} : { ownerId: req.user.id };
    const accounts = db.listAccounts(opts);
    const statuses = manager.getAllStatuses();
    res.json(accounts.map(a => ({ ...a, status: statuses[a.id] || { state: 'stopped', running: false } })));
});

app.post('/api/accounts', authMiddleware, (req, res) => {
    const { label, username, password, shared_secret, identity_secret, farm_game_ids, login_method, auto_confirm } = req.body;
    if (!label) return res.status(400).json({ error: 'label é obrigatório' });
    // admin can assign to any owner, users own it themselves
    const owner_id = (req.user.role === 'admin' && req.body.owner_id) ? Number(req.body.owner_id) : req.user.id;
    const id = db.createAccount({ owner_id, label, username, password, shared_secret, identity_secret, farm_game_ids, login_method, auto_confirm });
    res.json({ id });
});

app.put('/api/accounts/:id', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });

    const { label, username, password, shared_secret, identity_secret, farm_game_ids, login_method, auto_confirm, enabled, owner_id } = req.body;
    const data = {};
    if (label !== undefined) data.label = label;
    if (username !== undefined) data.username = username;
    if (password) data.password = password;
    if (shared_secret) data.shared_secret = shared_secret;
    if (identity_secret !== undefined) data.identity_secret = identity_secret;
    if (farm_game_ids !== undefined) data.farm_game_ids = farm_game_ids;
    if (login_method !== undefined) data.login_method = login_method;
    if (auto_confirm !== undefined) data.auto_confirm = auto_confirm ? 1 : 0;
    if (enabled !== undefined) data.enabled = enabled ? 1 : 0;
    if (req.user.role === 'admin' && owner_id !== undefined) data.owner_id = owner_id || null;
    db.updateAccount(id, data);
    res.json({ ok: true });
});

app.delete('/api/accounts/:id', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    manager.stopAccount(id);
    db.deleteAccount(id);
    res.json({ ok: true });
});

// ── Bot control ───────────────────────────────────────────

app.post('/api/accounts/:id/start', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    res.json(manager.startAccount(id));
});

app.post('/api/accounts/:id/stop', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    res.json(manager.stopAccount(id));
});

app.post('/api/accounts/:id/restart', authMiddleware, async (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    res.json(await manager.restartAccount(id));
});

app.get('/api/accounts/:id/status', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    res.json(manager.getStatus(id));
});

app.get('/api/accounts/:id/logs', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    res.json(manager.getLogs(id));
});

app.post('/api/accounts/:id/2fa', authMiddleware, (req, res) => {
    const id = Number(req.params.id);
    const account = db.getAccount(id);
    if (!canAccessAccount(req.user, account)) return res.status(403).json({ error: 'acesso negado' });
    const { code } = req.body;
    res.json({ ok: manager.sendToBot(id, { type: 'twoFactorCode', data: { code } }) });
});

// ── Start ─────────────────────────────────────────────────

async function ensureAdminUser() {
    if (db.countUsers() === 0) {
        const password = config.admin_key || 'admin';
        const hash = await bcrypt.hash(password, 10);
        const id = db.createUser({ username: 'admin', password_hash: hash, role: 'admin' });
        console.log(`Usuário admin criado automaticamente (id ${id}). Senha: "${password}"`);
        console.log('Mude a senha pelo painel depois!');
    }
}

server.listen(PORT, async () => {
    console.log(`Steam Farm Manager rodando em http://localhost:${PORT}`);
    await ensureAdminUser();

    // Auto-start enabled accounts
    setTimeout(() => {
        const accounts = db.listAccounts();
        for (const acc of accounts) {
            if (acc.enabled) {
                console.log(`Auto-iniciando: ${acc.label} (id ${acc.id})`);
                manager.startAccount(acc.id);
            }
        }
    }, 1500);
});
