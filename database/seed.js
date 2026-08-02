require('dotenv').config();

const db = require('./database');

db.close();
console.log('Seed executado com sucesso.');
console.log('Usuário admin padrão:', process.env.ADMIN_EMAIL || 'admin@sistema.com');
