const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp'); 
const readline = require('readline');
const client = new SteamUser();
const SteamCommunity = require('steamcommunity');
const fs = require('fs');
const path = require('path');
const community = new SteamCommunity();
const SENTRY_FILE = path.resolve(process.cwd(), 'sentry.bin');
const isInteractive = Boolean(process.stdin && process.stdin.isTTY);
const setupMode = process.argv.includes('--setup') || process.argv.includes('--init');
let setupPending = false;

let username = process.env.STEAM_USERNAME;
let password = process.env.STEAM_PASSWORD;
let sharedSecret = process.env.STEAM_SHARED_SECRET;
let modo2FA = 'auto';
let identitySecret = process.env.STEAM_IDENTITY_SECRET;
let autoConfirm = process.env.AUTO_CONFIRM === 'true';
const CONFIG_FILE = path.resolve(process.cwd(), 'config.json');

// Load config file if exists
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        username = username || cfg.username;
        password = password || cfg.password;
        sharedSecret = sharedSecret || cfg.shared_secret;
        identitySecret = identitySecret || cfg.identity_secret;
        autoConfirm = typeof cfg.auto_confirm === 'boolean' ? cfg.auto_confirm : autoConfirm;
        process.env.FARM_GAME_IDS = process.env.FARM_GAME_IDS || cfg.farm_game_ids;
        process.env.RETRY_MS = process.env.RETRY_MS || cfg.retry_ms;
    } catch (e) {
        console.warn('Falha ao ler config.json:', e.message);
    }
}

const CS2_APP_ID = 730;
const JOGOS_PARA_FARMAR = (process.env.FARM_GAME_IDS || '730')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
const RETRY_MS = Number(process.env.RETRY_MS || 30000);
const MAX_RETRY_MS = Number(process.env.MAX_RETRY_MS || 900000);
const RATE_LIMIT_BASE_MS = Number(process.env.RATE_LIMIT_BASE_MS || 300000);
const MAX_RATE_LIMIT_RETRIES = Number(process.env.MAX_RATE_LIMIT_RETRIES || 6);

let logando = false;
let conectado = false;
let farmPausado = false;
let retryTimeout = null;
let tentativasConsecutivas = 0;
let rateLimitConsecutivo = 0;

if (JOGOS_PARA_FARMAR.length === 0) {
    console.error('ERRO: FARM_GAME_IDS está vazio ou inválido. Exemplo: FARM_GAME_IDS=730,570');
    process.exit(1);
}

function perguntar(pergunta) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(pergunta, (resposta) => {
            rl.close();
            resolve((resposta || '').trim());
        });
    });
}

function sharedSecretPareceValido(secret) {
    if (!secret || secret.length < 16) {
        return false;
    }

    if (!/^[A-Za-z0-9+/=]+$/.test(secret)) {
        return false;
    }

    const decoded = Buffer.from(secret, 'base64');
    if (!decoded || decoded.length < 10) {
        return false;
    }

    return true;
}

async function carregarCredenciais() {
    if (!username) {
        username = await perguntar('Steam username: ');
    }

    if (!password) {
        password = await perguntar('Steam password: ');
    }

    if (!sharedSecret) {
        sharedSecret = await perguntar('Steam shared secret (Enter para modo manual): ');
    }

    while (sharedSecret) {
        if (!sharedSecretPareceValido(sharedSecret)) {
            console.error('Shared secret invalido: valor muito curto ou formato incorreto (base64).');
            sharedSecret = await perguntar('Steam shared secret: ');
            continue;
        }

        try {
            SteamTotp.generateAuthCode(sharedSecret);
            break;
        } catch (_err) {
            console.error('Shared secret invalido. Copie o valor completo (base64) sem espacos extras.');
            sharedSecret = await perguntar('Steam shared secret: ');
        }
    }

    if (!sharedSecret) {
        modo2FA = 'manual';
        console.warn('Modo manual ativado: o codigo Steam Guard sera solicitado quando necessario.');
        console.warn('Para rodar 24h sem intervencao, use um shared secret valido.');
    }

    // if identity secret supplied in config or env, enable autoConfirm by default
    if (identitySecret && !process.env.AUTO_CONFIRM) {
        autoConfirm = true;
    }

    if (!username || !password) {
        console.error('ERRO: usuário e senha são obrigatórios.');
        process.exit(1);
    }
}

// Função para tentar o login gerando o código de 2 fatores atualizado
function tentarLogin() {
    if (logando || conectado) {
        return;
    }

    logando = true;
    console.log("Gerando código Steam Guard automático...");
    const logOnOptions = {
        accountName: username,
        password: password
    };

    if (modo2FA === 'auto') {
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
    }

    // If we have a sentry file from a previous interactive login, reuse it so Steam won't ask for Guard again
    try {
        if (fs.existsSync(SENTRY_FILE)) {
            const sentry = fs.readFileSync(SENTRY_FILE);
            if (sentry && sentry.length) {
                logOnOptions.sentry = sentry;
                console.log('Usando sentry salvo para evitar Steam Guard (modo headless).');
            }
        }
    } catch (e) {
        // ignore
    }

    client.logOn(logOnOptions);
}

// Save sentry blob to disk so future headless restarts don't require Steam Guard input
client.on('sentry', (sentry) => {
    try {
        fs.writeFileSync(SENTRY_FILE, sentry);
        console.log(`Sentry salvo em ${SENTRY_FILE}`);
        try {
            if (process.platform !== 'win32') fs.chmodSync(SENTRY_FILE, 0o600);
        } catch (e) {
            // ignore chmod failures
        }
        if (setupMode) {
            console.log('Setup concluido: sentry salvo. Saindo.');
            process.exit(0);
        }
    } catch (e) {
        console.warn('Falha ao salvar sentry:', e.message);
    }
});

// If running under non-interactive environment (pm2) and no credentials/sentry, print instructions and exit
if (!isInteractive && !setupMode) {
    const hasSentry = fs.existsSync(SENTRY_FILE);
    if (!sharedSecret && !hasSentry) {
        console.error('Ambiente sem terminal interativo detectado (possivelmente PM2).');
        console.error('Não existe `shared_secret` configurado nem `sentry.bin` salvo.');
        console.error('Execute uma vez interativamente para gerar o sentry:');
        console.error('  node index.js --setup');
        console.error('Após autenticar interativamente e ver "Sentry salvo" você poderá rodar com PM2:');
        console.error('  pm2 start index.js --name cs2-farm');
        process.exit(1);
    }
}

// Quando obtivermos sessão web, damos os cookies para SteamCommunity para confirmar automaticamente
client.on('webSession', (sessionID, cookies) => {
    try {
        community.setCookies(cookies);
        console.log('Cookies de sessao web configurados para SteamCommunity.');

        if (autoConfirm && identitySecret) {
            console.log('Auto-confirm ativado. Iniciando verificador de confirmacoes...');
            // intervalo em ms: checar a cada 20s
            try {
                community.startConfirmationChecker(20 * 1000, identitySecret);
            } catch (e) {
                console.warn('Falha ao iniciar confirmation checker:', e.message);
            }
        }
    } catch (e) {
        console.warn('Erro ao setar cookies no SteamCommunity:', e.message);
    }
});

function agendarRelogin(motivo, atrasoMs = RETRY_MS) {
    if (retryTimeout) {
        return;
    }

    const atrasoRealMs = Math.min(Math.max(atrasoMs, RETRY_MS), MAX_RETRY_MS);
    console.log(`${motivo} Nova tentativa em ${Math.round(atrasoRealMs / 1000)}s...`);
    retryTimeout = setTimeout(() => {
        retryTimeout = null;
        tentarLogin();
    }, atrasoRealMs);
}

function calcularAtrasoErro(err) {
    const message = String(err?.message || '');

    if (message.includes('RateLimitExceeded')) {
        rateLimitConsecutivo += 1;
        tentativasConsecutivas += 1;
        const base = RATE_LIMIT_BASE_MS * Math.pow(2, Math.min(tentativasConsecutivas, 4));
        const jitter = Math.floor(Math.random() * 5000);
        return Math.min(base + jitter, MAX_RETRY_MS);
    }

    tentativasConsecutivas = 0;
    rateLimitConsecutivo = 0;
    return RETRY_MS;
}

function iniciarFarm() {
    if (!conectado || farmPausado) {
        return;
    }

    client.gamesPlayed(JOGOS_PARA_FARMAR);
    console.log(`Farmando horas nos jogos: ${JOGOS_PARA_FARMAR.join(', ')}`);
}

function pausarFarm(motivo) {
    if (farmPausado) {
        return;
    }

    farmPausado = true;
    client.gamesPlayed([]);
    console.log(`Farm pausado: ${motivo}`);
}

function retomarFarm() {
    if (!farmPausado) {
        return;
    }

    farmPausado = false;
    console.log('Retomando farm automaticamente...');
    iniciarFarm();
}

async function iniciarBot() {
    await carregarCredenciais();
    tentarLogin();
}

iniciarBot().catch((err) => {
    console.error('Falha ao iniciar o bot:', err.message);
    process.exit(1);
});

client.on('loggedOn', () => {
    logando = false;
    conectado = true;
    tentativasConsecutivas = 0;
    rateLimitConsecutivo = 0;
    console.log('Conectado com sucesso na Steam via Autenticador Celular!');
    client.setPersona(SteamUser.EPersonaState.Online); 
    iniciarFarm();
});

// Se a Steam pedir o código novamente por expiração, geramos outro na hora
client.on('steamGuard', async (domain, callback) => {
    console.log('Steam pediu revalidação do Steam Guard.');

    if (modo2FA === 'auto') {
        const autoCode = SteamTotp.generateAuthCode(sharedSecret);
        callback(autoCode);
        return;
    }

    const manualCode = await perguntar('Codigo Steam Guard (5 chars): ');
    callback(manualCode);
});

client.on('error', (err) => {
    logando = false;
    conectado = false;
    console.error('Erro encontrado no bot:', err.message);

    if (String(err?.message || '').includes('RateLimitExceeded') && rateLimitConsecutivo >= MAX_RATE_LIMIT_RETRIES) {
        console.error('Muitas tentativas bloqueadas pela Steam. Encerrando para evitar loop infinito.');
        console.error('Revise usuario/senha/shared secret e aguarde um tempo antes de tentar novamente.');
        process.exit(1);
    }

    const atraso = calcularAtrasoErro(err);
    agendarRelogin('Falha na conexão/login.', atraso);
});

client.on('disconnected', (eresult, msg) => {
    logando = false;
    conectado = false;
    console.warn(`Desconectado da Steam (EResult ${eresult}): ${msg || 'sem mensagem'}`);
    agendarRelogin('Conexão encerrada.', RETRY_MS);
});

client.on('playingState', (blocked, playingApp) => {
    if (!conectado) {
        return;
    }

    if (blocked && Number(playingApp) === CS2_APP_ID) {
        pausarFarm('CS2 iniciado manualmente.');
        return;
    }

    if (!blocked && farmPausado) {
        retomarFarm();
    }
});

process.on('SIGINT', () => {
    console.log('Encerrando bot...');
    try {
        client.gamesPlayed([]);
        client.logOff();
    } finally {
        process.exit(0);
    }
});

// If started with --setup, exit shortly after loggedOn if sentry wasn't emitted
if (setupMode) {
    setupPending = true;
    client.once('loggedOn', () => {
        setTimeout(() => {
            if (setupPending) {
                console.log('Setup finalizado (sem sentry explicitamente recebido). Saindo.');
                process.exit(0);
            }
        }, 3000);
    });
}
