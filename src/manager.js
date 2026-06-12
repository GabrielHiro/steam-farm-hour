const { fork } = require('child_process');
const path = require('path');
const db = require('./db');

const LOG_BUFFER_SIZE = 100;

// accountId -> { proc, status, logs, startedAt }
const processes = new Map();
let onMessageCallback = null;

function setOnMessage(fn) {
    onMessageCallback = fn;
}

function broadcast(accountId, msg) {
    if (onMessageCallback) onMessageCallback(accountId, msg);
}

function isRunning(entry) {
    return entry && entry.proc && !entry.proc.killed && entry.proc.exitCode === null;
}

function getStatus(accountId) {
    const entry = processes.get(accountId);
    if (!entry) return { state: 'stopped', running: false };
    return {
        ...entry.status,
        running: isRunning(entry),
        startedAt: entry.startedAt,
    };
}

function getAllStatuses() {
    const result = {};
    for (const [id, entry] of processes) {
        result[id] = {
            ...entry.status,
            running: isRunning(entry),
            startedAt: entry.startedAt,
        };
    }
    return result;
}

function getLogs(accountId) {
    return (processes.get(accountId) || {}).logs || [];
}

function startAccount(accountId) {
    const existing = processes.get(accountId);
    if (existing && isRunning(existing)) return { error: 'already_running' };

    const account = db.getAccount(accountId);
    if (!account) return { error: 'not_found' };

    const env = {
        ...process.env,
        ACCOUNT_ID: String(accountId),
        STEAM_USERNAME: account.username || '',
        STEAM_PASSWORD: account.password || '',
        STEAM_SHARED_SECRET: account.shared_secret || '',
        STEAM_IDENTITY_SECRET: account.identity_secret || '',
        STEAM_REFRESH_TOKEN: account.refresh_token || '',
        LOGIN_METHOD: account.login_method || 'credentials',
        AUTO_CONFIRM: account.auto_confirm ? 'true' : 'false',
        FARM_GAME_IDS: account.farm_game_ids || '730',
    };

    const proc = fork(path.join(__dirname, 'bot.js'), [], {
        env,
        stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    });

    const entry = {
        proc,
        status: { state: 'starting' },
        logs: [],
        startedAt: Date.now(),
    };
    processes.set(accountId, entry);

    proc.on('message', (msg) => {
        if (!msg || !msg.type) return;

        if (msg.type === 'status') {
            entry.status = { ...msg.data, running: true };
        }
        if (msg.type === 'log') {
            entry.logs.push({ ts: msg.data.ts || Date.now(), message: msg.data.message });
            if (entry.logs.length > LOG_BUFFER_SIZE) entry.logs.shift();
        }
        if (msg.type === 'refreshToken') {
            db.updateAccount(accountId, { refresh_token: msg.data.token });
        }

        broadcast(accountId, msg);
    });

    proc.on('exit', (code) => {
        entry.status = { state: 'stopped', running: false, exitCode: code };
        broadcast(accountId, { type: 'status', data: entry.status });
    });

    proc.on('error', (err) => {
        entry.status = { state: 'error', running: false, message: err.message };
        broadcast(accountId, { type: 'status', data: entry.status });
    });

    return { ok: true };
}

function stopAccount(accountId) {
    const entry = processes.get(accountId);
    if (!entry || !isRunning(entry)) return { error: 'not_running' };

    try {
        entry.proc.send({ type: 'stop' });
        setTimeout(() => {
            if (isRunning(entry)) entry.proc.kill('SIGTERM');
        }, 5000);
    } catch (e) {
        entry.proc.kill('SIGTERM');
    }

    return { ok: true };
}

async function restartAccount(accountId) {
    const entry = processes.get(accountId);
    if (entry && isRunning(entry)) {
        stopAccount(accountId);
        // Wait for process to die
        await new Promise((resolve) => {
            const check = setInterval(() => {
                const e = processes.get(accountId);
                if (!e || !isRunning(e)) { clearInterval(check); resolve(); }
            }, 200);
            setTimeout(() => { clearInterval(check); resolve(); }, 6000);
        });
    }
    return startAccount(accountId);
}

function sendToBot(accountId, msg) {
    const entry = processes.get(accountId);
    if (!entry || !isRunning(entry)) return false;
    try { entry.proc.send(msg); return true; } catch (e) { return false; }
}

module.exports = {
    startAccount,
    stopAccount,
    restartAccount,
    getStatus,
    getAllStatuses,
    getLogs,
    setOnMessage,
    sendToBot,
};
