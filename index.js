const SteamUser = require('steam-user');
const client = new SteamUser();

// CONFIGURAÇÃO DOS SEUS DADOS
const logOnOptions = {
    accountName: process.env.STEAM_USERNAME || 'hirogabri3l', // Substitua pelo seu nome de usuário da Steam
    password: process.env.STEAM_PASSWORD || 'Hiroyu10'
};

// COLOQUE OS IDs DOS JOGOS QUE QUER FARMAR (Ex: 730 é o CS2)
const JOGOS_PARA_FARMAR = [730]; 

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log('Conectado com sucesso na Steam!');
    client.setPersona(SteamUser.EPersonaState.Online); // Fica online na Steam
    client.gamesPlayed(JOGOS_PARA_FARMAR); // Inicia o farm de horas
    console.log(`Farmando horas nos jogos: ${JOGOS_PARA_FARMAR.join(', ')}`);
});

// Executado apenas na primeira vez se você tiver Steam Guard no celular/email
client.on('steamGuard', (domain, callback) => {
    console.log(`Steam Guard necessário (${domain}). Digite o código gerado no seu app/e-mail no terminal:`);
    process.stdin.once('data', (data) => {
        callback(data.toString().trim());
    });
});

// Salva o token de login para não pedir Steam Guard na nuvem
client.on('webSession', (sessionID, cookies) => {
    console.log('Sessão iniciada e salva.');
});

client.on('error', (err) => {
    console.error('Erro encontrado:', err.message);
});
