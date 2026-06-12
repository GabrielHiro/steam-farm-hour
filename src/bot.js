const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const fs = require('fs');
const path = require('path');

const accountId = process.env.ACCOUNT_ID || 'default';
const username = process.env.STEAM_USERNAME || '';
const password = process.env.STEAM_PASSWORD || '';
const sharedSecret = process.env.STEAM_SHARED_SECRET || '';
const identitySecret = process.env.STEAM_IDENTITY_SECRET || '';
const savedRefreshToken = process.env.STEAM_REFRESH_TOKEN || '';
const loginMethod = process.env.LOGIN_METHOD || 'credentials';
const autoConfirm = process.env.AUTO_CONFIRM === 'true';
const farmGameIds = (process.env.FARM_GAME_IDS || '730')
    .split(',').map(s => Number(s.trim())).filter(n => n > 0);

const DATA_DIR = path.resolve(process.cwd(), 'data', String(accountId));
fs.mkdirSync(DATA_DIR, { recursive: true });

const SENTRY_FILE = path.join(DATA_DIR, 'sentry.bin');
const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json');

const RETRY_MS = Number(process.env.RETRY_MS || 30000);
const MAX_RETRY_MS = Number(process.env.MAX_RETRY_MS || 900000);

const client = new SteamUser();
const community = new SteamCommunity();

let connected = false;
let farmPaused = false;
let retryTimeout = null;
let rateLimitCount = 0;
let activeSession = null; // steam-session LoginSession for QR
let farmStartedAt = null;

function ipc(type, data) {
    if (process.send) {
        try { process.send({ type, data }); } catch (e) {}
    }
}

function log(msg) {
    console.log(`[bot:${accountId}] ${msg}`);
    ipc('log', { message: msg, ts: Date.now() });
}

function sendStatus(state, message = '') {
    ipc('status', { state, message, farmStartedAt });
}

function startFarm() {
    if (!connected || farmPaused) return;
    client.gamesPlayed(farmGameIds);
    farmStartedAt = farmStartedAt || Date.now();
    sendStatus('farming', `Farmando: ${farmGameIds.join(', ')}`);
    log(`Farm iniciado: ${farmGameIds.join(', ')}`);
}

function pauseFarm(reason) {
    if (farmPaused) return;
    farmPaused = true;
    client.gamesPlayed([]);
    sendStatus('paused', reason);
    log(`Farm pausado: ${reason}`);
}

function resumeFarm() {
    if (!farmPaused) return;
    farmPaused = false;
    log('Retomando farm...');
    startFarm();
}

function scheduleRelogin(delayMs = RETRY_MS) {
    if (retryTimeout) return;
    const delay = Math.min(Math.max(delayMs, RETRY_MS), MAX_RETRY_MS);
    log(`Reconectando em ${Math.round(delay / 1000)}s...`);
    retryTimeout = setTimeout(() => { retryTimeout = null; doLogin(); }, delay);
}

async function doQRLogin() {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    activeSession = session;

    session.on('authenticated', async () => {
        const token = session.refreshToken;
        log('QR autenticado. Refresh token recebido.');
        ipc('refreshToken', { token });
        // Now log into steam-user with the refresh token
        client.logOn({ refreshToken: token });
    });

    session.on('error', (err) => {
        log(`Erro na sessão QR: ${err.message}`);
        sendStatus('error', err.message);
        scheduleRelogin();
    });

    try {
        const result = await session.startWithQR();
        if (result.qrChallengeUrl) {
            ipc('qrCode', { url: result.qrChallengeUrl });
            sendStatus('waiting_qr', 'Escaneie o QR Code com o app Steam');
        }
    } catch (err) {
        log(`Falha ao iniciar QR: ${err.message}`);
        sendStatus('error', err.message);
        scheduleRelogin();
    }
}

async function doLogin() {
    if (connected) return;
    sendStatus('connecting');

    // Refresh token takes priority — avoids QR scan on restart
    if (savedRefreshToken) {
        client.logOn({ refreshToken: savedRefreshToken });
        return;
    }

    if (loginMethod === 'qr') {
        await doQRLogin();
        return;
    }

    // Credentials mode
    const opts = {
        accountName: username,
        password: password,
    };
    if (sharedSecret) {
        opts.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
    }
    try {
        if (fs.existsSync(SENTRY_FILE)) {
            const sentry = fs.readFileSync(SENTRY_FILE);
            if (sentry.length) opts.sentry = sentry;
        }
    } catch (e) {}

    client.logOn(opts);
}

// Load saved cookies into SteamCommunity
if (fs.existsSync(COOKIE_FILE)) {
    try {
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        if (Array.isArray(cookies) && cookies.length) community.setCookies(cookies);
    } catch (e) {}
}

client.on('loggedOn', () => {
    connected = true;
    rateLimitCount = 0;
    log('Conectado!');
    // Invisible so friends don't see the account online / send game invites
    client.setPersona(SteamUser.EPersonaState.Invisible);
    sendStatus('connected');
    startFarm();
});

client.on('sentry', (sentry) => {
    try {
        fs.writeFileSync(SENTRY_FILE, sentry);
        if (process.platform !== 'win32') fs.chmodSync(SENTRY_FILE, 0o600);
        log('Sentry salvo.');
    } catch (e) {}
});

client.on('webSession', (sessionId, cookies) => {
    try {
        community.setCookies(cookies);
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
        if (process.platform !== 'win32') fs.chmodSync(COOKIE_FILE, 0o600);
        log('Cookies salvos.');
    } catch (e) {}

    if (autoConfirm && identitySecret) {
        try { community.startConfirmationChecker(20000, identitySecret); } catch (e) {}
    }
});

client.on('steamGuard', (domain, callback) => {
    log('Steam pediu código 2FA.');
    if (sharedSecret) {
        callback(SteamTotp.generateAuthCode(sharedSecret));
        return;
    }
    sendStatus('needs_2fa', 'Código Steam Guard necessário');
    ipc('needs2FA', { domain });
    process.once('message', (msg) => {
        if (msg && msg.type === 'twoFactorCode') callback(msg.data.code);
    });
});

client.on('playingState', (blocked, playingApp) => {
    if (!connected) return;
    if (blocked) {
        pauseFarm(`Usuário iniciou jogo ${playingApp}`);
    } else if (farmPaused) {
        resumeFarm();
    }
});

client.on('error', (err) => {
    connected = false;
    log(`Erro: ${err.message}`);
    sendStatus('error', err.message);

    if (err.message.includes('RateLimitExceeded')) {
        rateLimitCount += 1;
        const delay = 300000 * Math.pow(2, Math.min(rateLimitCount - 1, 4));
        scheduleRelogin(delay + Math.floor(Math.random() * 5000));
    } else {
        rateLimitCount = 0;
        scheduleRelogin();
    }
});

client.on('disconnected', (eresult, msg) => {
    connected = false;
    log(`Desconectado (${eresult}): ${msg || ''}`);
    sendStatus('disconnected', `EResult ${eresult}`);
    scheduleRelogin();
});

process.on('message', (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'stop') {
        log('Parando...');
        if (activeSession) { try { activeSession.cancelLoginAttempt(); } catch (e) {} }
        try { client.gamesPlayed([]); client.logOff(); } catch (e) {}
        process.exit(0);
    }
    if (msg.type === 'twoFactorCode') {
        // handled in steamGuard listener above via process.once
    }
});

process.on('SIGINT', () => {
    if (activeSession) { try { activeSession.cancelLoginAttempt(); } catch (e) {} }
    try { client.gamesPlayed([]); client.logOff(); } catch (e) {}
    process.exit(0);
});

sendStatus('starting');
doLogin().catch((err) => {
    log(`Falha no login: ${err.message}`);
    sendStatus('error', err.message);
    scheduleRelogin();
});
