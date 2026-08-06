/*
 * server.js
 *
 * Ponto de entrada da plataforma "PapiCore" — SaaS multi-tenant.
 *
 * Três áreas:
 *   1. Pública (/)      — agendamento, abre o banco pelo domínio da empresa;
 *   2. Administrativa   — /admin (domínio da empresa), banco pelo usuário logado;
 *   3. Desenvolvedor    — /desenvolvedor (exclusivo role=developer).
 *
 * Bancos:
 *   data/papi_core.db               → controle da plataforma (tenants, users,
 *                                     tenant_domains, plans, logs);
 *   data/tenants/tenant_XXXX_slug.db→ um banco SQLite por empresa.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { initCore } = require('./database/coreDatabase');
const { requireAuth } = require('./middlewares/auth');
const tenantMiddleware = require('./middlewares/tenantMiddleware');
const { resolveTenantByHost, normalizeDomain } = require('./middlewares/domainTenantMiddleware');
const errorHandler = require('./middlewares/errorHandler');

/*
 * Falha rápido e com mensagem clara se variáveis obrigatórias não estiverem
 * configuradas no ambiente. Sem isso, JWT_SECRET ausente (comum em serviços
 * como Render, onde o .env local não é enviado) faz jwt.sign() estourar uma
 * exceção genérica só no momento do login, que o errorHandler traduz para um
 * 500 "Erro interno do servidor" sem pista nenhuma da causa real.
 */
const REQUIRED_ENV_VARS = ['JWT_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length) {
  console.error(
    `[papi-core] Variáveis de ambiente obrigatórias ausentes: ${missingEnvVars.join(', ')}.`
  );
  console.error(
    '[papi-core] Configure-as no ambiente de execução (ex.: Environment do serviço no Render) antes de iniciar o servidor.'
  );
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && !process.env.DATA_DIR) {
  console.error(
    '[papi-core] DATA_DIR não configurado. Configure DATA_DIR=/var/data.'
  );
  process.exit(1);
}

/* Inicializa o banco central, migra o app.db legado e garante o tenant padrão. */
initCore();

/* Agenda a rotina automática de backups locais (produção + habilitação). */
const { startBackupScheduler } = require('./services/backupScheduler');
startBackupScheduler();

const publicRoutes = require('./routes/publicRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const developerRoutes = require('./routes/developerRoutes');
const commercialRoutes = require('./routes/commercialRoutes');
const publicApiRoutes = require('./routes/publicApiRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

/* O Render termina o TLS no proxy e repassa X-Forwarded-For/Proto/Host.
   Com trust proxy, req.protocol, req.hostname e req.ip refletem o cliente
   original (o login do desenvolvedor usa req.ip no rate limit). */
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  /* API sempre fresca: evita que navegador/proxy sirva resposta em cache da
     Agenda e esconda agendamentos criados após o primeiro carregamento. */
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

/* Domínio institucional da plataforma (process.env.PLATFORM_DOMAIN): a raiz
   deste domínio abre a landing page comercial do PapiCore em vez da página
   pública de agendamento (que pertence aos tenants). O host é normalizado
   (remove porta, minúsculas, remove www), então papicore.com.br e
   www.papicore.com.br caem no mesmo caso. Em desenvolvimento, localhost e
   127.0.0.1 também abrem a landing page (não há domínio de plataforma real
   para testar localmente) — o painel do desenvolvedor continua em
   /desenvolvedor e um tenant específico pode ser visto em /agendar/:slug.
   Registrada ANTES do express.static — que entrega o index.html do tenant
   (booking) na raiz para qualquer outro host — e antes de qualquer
   middleware que resolva tenant para a página inicial. Não afeta
   /admin, /desenvolvedor, /api nem os domínios dos clientes, que continuam
   resolvendo normalmente pelo host. */
const platformDomain = normalizeDomain(process.env.PLATFORM_DOMAIN || '');

function isPlatformHost(host) {
  const currentHost = normalizeDomain(host);
  if (platformDomain && currentHost === platformDomain) return true;
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(currentHost)) return true;
  return false;
}

app.get('/', (req, res, next) => {
  if (isPlatformHost(req.hostname || req.headers.host)) {
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
  return next();
});

/* O painel do desenvolvedor é exclusivo da plataforma: papicore.com.br/
   /desenvolvedor. Em qualquer outro host — incluindo os domínios dos
   clientes — o caminho /desenvolvedor e o arquivo /desenvolvedor.html não
   existem e respondem 404, como se nunca tivessem sido servidos. Isso
   impede que www.cliente.com.br/desenvolvedor exponha o painel. */
const DEVELOPER_PATHS = new Set(['/desenvolvedor', '/desenvolvedor/login', '/desenvolvedor.html']);

app.use((req, res, next) => {
  if (DEVELOPER_PATHS.has(req.path) && !isPlatformHost(req.hostname || req.headers.host)) {
    return res.status(404).send('Não encontrado.');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* /api/auth, /api/admin e /api/developer precisam ser registradas antes de
   publicRoutes: publicRoutes aplica domainTenantMiddleware a toda requisição
   que passa por ela (router.use, sem path específico), incluindo 403 se a
   empresa do domínio atual estiver suspensa. Como todas essas rotas também
   começam com /api, se publicRoutes fosse montada primeiro, suspender a
   empresa associada ao domínio/host atual derrubaria login do desenvolvedor
   e de outras empresas nesse mesmo host — sem nenhuma relação com a rota
   pública de agendamento. */
app.use('/api/auth', authRoutes);
app.use('/api/admin', requireAuth, tenantMiddleware, adminRoutes);
/* O login do desenvolvedor precisa ficar acessível sem token; a proteção
   requireDeveloper é aplicada rota a rota dentro de developerRoutes.js. */
app.use('/api/developer', developerRoutes);
/* Site institucional (planos comerciais + formulário de contato): não
   pertence a nenhum tenant, então precisa responder mesmo no domínio da
   própria plataforma (sem empresa associada). Por isso é registrada antes de
   publicRoutes, cujo domainTenantMiddleware bloquearia (404) qualquer
   requisição vinda de um host sem tenant cadastrado — como papicore.com.br. */
app.use('/api/public', commercialRoutes);

/* Webhooks da Evolution API: rota pública sem auth/tenant, a validação é
   feita por token dentro do whatsappService. Registrada antes de
   resolveTenantByHost para não depender do domínio/host da requisição. */
app.use('/api/webhooks/whatsapp', webhookRoutes);

/* API pública /api/v1 — autenticada por chave de API. Registrada antes de
   publicRoutes: o tenant vem da chave (apiKeyMiddleware), NÃO do domínio da
   requisição, então não pode passar pelo domainTenantMiddleware. */
app.use('/api/v1', publicApiRoutes);

/* Documentação interativa da API pública (ReDoc). Pública e sem tenant —
   apenas a spec de /api/v1/openapi.json, sem nenhum dado de cliente. */
app.get('/api/docs', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PapiCore API — Documentação</title>
  <style>body{margin:0;padding:0}</style>
</head>
<body>
  <redoc spec-url="/api/v1/openapi.json"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body>
</html>`);
});

/* Identifica a empresa pelo domínio da requisição em toda a API
   (usado no login para validar que o usuário pertence à empresa do domínio). */
app.use('/api', resolveTenantByHost);

app.use('/api', publicRoutes);

/* Páginas */
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* Redefinição de senha: mesma página do admin, em outro "modo" (o token vem
   na query string e é lido pelo front-end). Ver public/admin.js. */
app.get('/admin/redefinir-senha', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/desenvolvedor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'desenvolvedor.html'));
});

app.get('/desenvolvedor/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'desenvolvedor.html'));
});

/* Páginas institucionais (site comercial) */
app.get('/privacidade', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidade.html'));
});

app.get('/termos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'termos.html'));
});

/* Área pública por slug (ex.: /agendar/seu-cliente). A resolução do banco
   na API permanece baseada no domínio configurado da empresa. */
app.get('/agendar/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PapiCore rodando em http://localhost:${PORT}`);
});
