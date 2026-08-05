# Recuperação de senha — Painel administrativo dos tenants

Fluxo de "esqueci minha senha" para os usuários administrativos de cada empresa
(`https://dominio-do-cliente.com.br/admin`). Não afeta o login do Painel do
Desenvolvedor (`/desenvolvedor`), que continua exigindo a senha atual para
trocar de senha (`POST /api/developer/change-password`).

## Fluxo

1. Na tela de login do `/admin`, o usuário clica em **Esqueci minha senha** e
   informa o e-mail cadastrado.
2. O backend identifica a empresa pelo domínio da requisição (o mesmo
   mecanismo do login normal — `resolveTenantByHost`) e procura o usuário
   **somente dentro daquele tenant** (`getUserByEmailAndTenant`). Um e-mail
   cadastrado na empresa A nunca é encontrado ao solicitar recuperação pelo
   domínio da empresa B.
3. Se o e-mail existir, estiver ativo e a empresa estiver ativa, um token
   aleatório de 32 bytes é gerado (`crypto.randomBytes`). Só o hash SHA-256 do
   token é salvo no banco (`password_reset_tokens.token_hash`); o token puro
   existe apenas durante a geração do link.
4. Um e-mail é enviado (via Brevo) com o link
   `https://<mesmo-domínio-da-solicitação>/admin/redefinir-senha?token=...`,
   válido por `PASSWORD_RESET_TOKEN_TTL_MINUTES` (padrão 30 minutos).
5. **A resposta ao usuário é sempre a mesma mensagem genérica** — "Se o
   e-mail estiver cadastrado, enviaremos as instruções de recuperação." —
   independente de o e-mail existir, pertencer a outro tenant, estar inativo
   ou de o envio falhar. Isso evita que alguém descubra, por tentativa e
   erro, quais e-mails têm conta em qual empresa.
6. O usuário abre o link, informa a nova senha (mínimo 8 caracteres, com
   maiúscula, minúscula e número) e confirma.
7. O backend revalida o token do zero (nunca confia numa validação anterior),
   grava a nova senha com bcrypt, marca o token como usado e invalida
   qualquer outro token ainda ativo do mesmo usuário — tudo em uma única
   transação.
8. Sessões (JWT) emitidas antes da troca deixam de funcionar: o token carrega
   um carimbo da senha (`pwd`), comparado a cada requisição com
   `users.password_changed_at`. Vale para qualquer usuário do painel — não só
   o owner.
9. O usuário volta para o login e entra com a nova senha.

## Configuração da Brevo

A chave da API, o e-mail e o nome do remetente podem ser configurados de duas
formas (a primeira tem prioridade quando preenchida):

- **Painel do Desenvolvedor → Configurações → Integração de e-mail (Brevo)**
  — não exige redeploy nem acesso ao ambiente de produção. A chave nunca é
  devolvida em texto puro pela API; a tela mostra só os últimos 4 caracteres.
- Variáveis de ambiente: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`,
  `BREVO_SENDER_NAME`, `EMAIL_ENABLED` (ver `.env.example`).

O remetente (`BREVO_SENDER_EMAIL`) precisa estar verificado na conta da
Brevo, com **SPF e DKIM configurados no DNS do domínio de envio**
(ex.: `papicore.com.br`) — sem isso, os e-mails caem em spam ou são
rejeitados pelo provedor do destinatário.

## Modo desenvolvimento (sem Brevo configurada)

Com `EMAIL_ENABLED=false` (padrão) ou sem a Brevo habilitada/configurada
pelo painel:

- nenhuma chamada é feita à Brevo;
- em `NODE_ENV !== 'production'`, o link de recuperação é impresso no
  console do servidor (`[password-reset][dev] ...`) para permitir testar o
  fluxo localmente;
- em produção, o link **nunca** aparece em log — a resposta ao usuário
  continua a mesma mensagem genérica.

Se o envio falhar (chave inválida, Brevo fora do ar, etc.), o erro é
registrado no console e no log de auditoria (`PASSWORD_RESET_EMAIL_FAILED`);
o usuário continua recebendo a mensagem genérica normalmente.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `EMAIL_ENABLED` | `false` | Liga o envio via Brevo (também pode ser ligado pelo painel) |
| `BREVO_API_KEY` | — | Chave da API transacional da Brevo |
| `BREVO_SENDER_EMAIL` | — | E-mail remetente verificado na Brevo |
| `BREVO_SENDER_NAME` | `PapiCore` | Nome exibido como remetente |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | `30` | Validade do link de recuperação |
| `PASSWORD_RESET_RATE_LIMIT_WINDOW_MINUTES` | `15` | Janela do limite por IP |
| `PASSWORD_RESET_RATE_LIMIT_MAX` | `5` | Máx. de solicitações por IP na janela |

O limite por e-mail + tenant (3 solicitações a cada 30 minutos) não é
configurável por variável de ambiente.

## Segurança

- Token aleatório de 32 bytes (`crypto.randomBytes`), salvo só como hash
  SHA-256 — nunca em texto puro.
- Expiração (30 min por padrão) e uso único: o token é marcado `used_at` na
  redefinição e nunca mais funciona (proteção contra replay).
- Uma nova solicitação invalida qualquer token anterior ainda ativo do mesmo
  usuário.
- Isolamento por tenant em toda a cadeia: geração, validação e redefinição
  sempre conferem que o token pertence ao tenant do domínio atual.
- Resposta sempre genérica em `forgot-password`, com piso de tempo mínimo de
  resposta (~300ms) para reduzir diferença de timing entre e-mail
  existente/inexistente.
- Rate limit por IP e por e-mail + tenant.
- Nunca loga token puro, senha, `password_hash` ou a API key da Brevo.
- Limpeza automática: tokens usados/expirados há mais de 24h são removidos
  no boot do servidor e a cada novo token gerado.

## Endpoints

Base: `/api/auth` (públicos, isolados pelo domínio da requisição).

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/forgot-password` | `{ email }` → sempre `{ message }` genérico |
| POST | `/reset-password/validate` | `{ token }` → `{ valid: true }` ou `{ valid: false, message }` |
| POST | `/reset-password` | `{ token, password, password_confirmation }` → `{ success: true }` |

Painel do Desenvolvedor (exige `Authorization: Bearer <token>` de
desenvolvedor):

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/developer/settings/email` | Configuração atual (chave mascarada) |
| PUT | `/api/developer/settings/email` | Atualiza habilitação/chave/remetente |

## Testes

```
node scripts/testPasswordResetSystem.js
```

Roda em um `DATA_DIR` temporário isolado (não toca dados reais), com um
tenant, domínio e usuário descartáveis, e mocka a chamada HTTP à Brevo.
Cobre: isolamento por tenant, resposta genérica, hash do token, expiração,
reuso (replay), rate limit, usuário inativo, domínio desconhecido, Brevo
desligada/com erro e invalidação de sessão antiga após a troca.

## Problemas comuns

- **E-mail não chega**: confira `EMAIL_ENABLED`/habilitação no painel, a
  chave da API, o remetente verificado na Brevo e o SPF/DKIM do domínio de
  envio. Em desenvolvimento, olhe o console do servidor — o link de teste é
  impresso ali.
- **"Link inválido ou expirado"**: o token já foi usado, expirou (30 min por
  padrão) ou uma solicitação mais recente foi feita para o mesmo usuário
  (a mais recente sempre invalida as anteriores).
- **"Domínio não cadastrado nesta plataforma"**: o host da requisição não
  está em `tenant_domains` (produção) nem é `localhost`/`127.0.0.1` em
  desenvolvimento. Cadastre o domínio no Painel do Desenvolvedor.
- **Sessão antiga continua entrando**: só é invalidada depois de uma
  redefinição de senha bem-sucedida (ou reset feito pelo desenvolvedor) —
  trocas de senha anteriores a esta funcionalidade não têm efeito
  retroativo.
