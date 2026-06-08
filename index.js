const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp'); 
const client = new SteamUser();

const username = process.env.STEAM_USERNAME;
const password = process.env.STEAM_PASSWORD;
const sharedSecret = process.env.STEAM_SHARED_SECRET;

const JOGOS_PARA_FARMAR = [730]; // Substitua pelos IDs dos seus jogos

if (!username || !password || !sharedSecret) {
    console.error("ERRO: As variáveis STEAM_USERNAME, STEAM_PASSWORD ou STEAM_SHARED_SECRET não foram configuradas no Railway!");
    process.exit(1);
}

// Função para tentar o login gerando o código de 2 fatores atualizado
function tentarLogin() {
    console.log("Gerando código Steam Guard automático...");
    const logOnOptions = {
        accountName: username,
        password: password,
        twoFactorCode: SteamTotp.generateAuthCode(sharedSecret)
    };
    client.logOn(logOnOptions);
}

tentarLogin();

client.on('loggedOn', () => {
    console.log('Conectado com sucesso na Steam via Autenticador Celular!');
    client.setPersona(SteamUser.EPersonaState.Online); 
    client.gamesPlayed(JOGOS_PARA_FARMAR); 
    console.log(`Farmando horas nos jogos: ${JOGOS_PARA_FARMAR.join(', ')}`);
});

// Se a Steam pedir o código novamente por expiração, geramos outro na hora
client.on('steamGuard', (domain, callback) => {
    console.log('Steam pediu revalidação do Steam Guard.');
    const autoCode = SteamTotp.generateAuthCode(sharedSecret);
    callback(autoCode);
});

client.on('error', (err) => {
    console.error('Erro encontrado no bot:', err.message);
    // Se der erro de taxa de tentativas ou falha de login, ele tenta de novo em 30 segundos
    if (err.message.includes("RateLimitExceeded") || err.message.includes("InvalidPassword")) {
        console.log("Aguardando 30 segundos para tentar novamente...");
        setTimeout(tentarLogin, 30000);
    }
});
