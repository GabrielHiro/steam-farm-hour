const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp'); 
const client = new SteamUser();

const username = process.env.STEAM_USERNAME;
const password = process.env.STEAM_PASSWORD;
const sharedSecret = process.env.STEAM_SHARED_SECRET;

const CS2_APP_ID = 730;
const JOGOS_PARA_FARMAR = (process.env.FARM_GAME_IDS || '730')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
const RETRY_MS = Number(process.env.RETRY_MS || 30000);

let logando = false;
let conectado = false;
let farmPausado = false;
let retryTimeout = null;

if (!username || !password || !sharedSecret) {
    console.error('ERRO: Configure STEAM_USERNAME, STEAM_PASSWORD e STEAM_SHARED_SECRET no ambiente da sua máquina hospedada.');
    process.exit(1);
}

if (JOGOS_PARA_FARMAR.length === 0) {
    console.error('ERRO: FARM_GAME_IDS está vazio ou inválido. Exemplo: FARM_GAME_IDS=730,570');
    process.exit(1);
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
        password: password,
        twoFactorCode: SteamTotp.generateAuthCode(sharedSecret)
    };
    client.logOn(logOnOptions);
}

function agendarRelogin(motivo) {
    if (retryTimeout) {
        return;
    }

    console.log(`${motivo} Nova tentativa em ${Math.round(RETRY_MS / 1000)}s...`);
    retryTimeout = setTimeout(() => {
        retryTimeout = null;
        tentarLogin();
    }, RETRY_MS);
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

tentarLogin();

client.on('loggedOn', () => {
    logando = false;
    conectado = true;
    console.log('Conectado com sucesso na Steam via Autenticador Celular!');
    client.setPersona(SteamUser.EPersonaState.Online); 
    iniciarFarm();
});

// Se a Steam pedir o código novamente por expiração, geramos outro na hora
client.on('steamGuard', (domain, callback) => {
    console.log('Steam pediu revalidação do Steam Guard.');
    const autoCode = SteamTotp.generateAuthCode(sharedSecret);
    callback(autoCode);
});

client.on('error', (err) => {
    logando = false;
    conectado = false;
    console.error('Erro encontrado no bot:', err.message);
    agendarRelogin('Falha na conexão/login.');
});

client.on('disconnected', (eresult, msg) => {
    logando = false;
    conectado = false;
    console.warn(`Desconectado da Steam (EResult ${eresult}): ${msg || 'sem mensagem'}`);
    agendarRelogin('Conexão encerrada.');
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
