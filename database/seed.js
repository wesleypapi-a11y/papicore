/*
 * seed.js
 *
 * Inicializa a plataforma "PapiCore":
 *   - cria o banco central (papi_core.db) com planos, tenant padrão e usuários;
 *   - migra data/app.db (quando existir) para o banco da primeira empresa;
 *   - cria o banco padrão do primeiro cliente quando necessário.
 */

require('dotenv').config();

const { initCore } = require('./coreDatabase');

initCore();

console.log('Seed da plataforma executado com sucesso.');
console.log('Banco central:', require('./coreDatabase').CORE_FILE);
console.log('Usuário desenvolvedor:', process.env.DEVELOPER_EMAIL || 'developer@papi.app');
console.log('Administrador da primeira empresa:', process.env.ADMIN_EMAIL || 'admin@sistema.com');
