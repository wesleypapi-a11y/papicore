# Contratos — PapiCore

Aba **Contratos** do painel do desenvolvedor: modelo editável, preenchimento
automático a partir dos dados da empresa cliente e do plano contratado,
geração de PDF e histórico de contratos.

> **AVISO IMPORTANTE:** o modelo inicial fornecido é um texto administrativo
> estruturado, **não uma peça jurídica pronta**. Ele deve ser revisado por um
> advogado antes de ser usado com clientes reais. O aviso aparece na própria
> tela de Modelos e de Novo contrato.

## Conceitos

- **Contratada**: a própria PapiCore. Dados fixos (`contract_company_settings`),
  **um único registro global** (linha `id = 1`, mesmo padrão de
  `site_content`), reaproveitado em todo contrato gerado, para qualquer
  empresa cliente.
- **Modelo** (`contract_templates`): texto com placeholders, **global** (não
  pertence a nenhuma empresa cliente — é mantido pelo desenvolvedor e
  reaproveitado para gerar contrato de qualquer uma delas). Versionado por
  família via `slug` (`UNIQUE(slug, version)`): editar um modelo nunca
  sobrescreve a versão anterior, sempre cria `version + 1` e marca essa nova
  versão como padrão (`is_default`) da família.
- **Contrato** (`contracts`): gerado **para uma empresa cliente** (`tenant_id`).
  Guarda um snapshot congelado da contratada, do cliente e do plano no
  momento da geração (`provider_snapshot_json`, `client_snapshot_json`,
  `plan_snapshot_json`) — mudar o cadastro da empresa ou o preço do plano
  depois **nunca** altera um contrato já gerado.

### Por que a numeração é um contador global (não por empresa)

O número final (`PC-2026-000001`) não identifica a empresa. Se o contador
fosse por `(tenant_id, ano)`, duas empresas diferentes gerando o primeiro
contrato do ano cairiam no mesmo número formatado, violando o
`UNIQUE(contract_number)`. Por isso `contract_sequences` é `PRIMARY KEY (year)`
e a reserva (`reserveContractNumber`) roda **na mesma transação** do insert do
contrato — nunca é `count(*) + 1`.

## Ciclo de vida

```
DRAFT  → (finalizar) →  FINALIZED  → (cancelar) → CANCELLED
  ↑                          │
  └── duplicar/renovar/aditivo (sempre cria um contrato novo, nunca edita o antigo)
```

- **DRAFT**: texto e dados editáveis livremente (`PUT /contracts/:id`).
- **FINALIZED**: imutável. Gera o PDF, grava hash SHA-256 e trava edição do
  texto — qualquer mudança exige duplicar, renovar ou gerar aditivo.
- **CANCELLED**: só a partir de `FINALIZED`, com motivo opcional.
- **Renovação**: novo rascunho vinculado (`previous_contract_id` e
  `replaces_contract_id` apontando para o original), com o plano/preço
  **atuais** da empresa (podem ter mudado desde o contrato anterior).
- **Aditivo**: novo rascunho com numeração própria e PDF próprio,
  referenciando o contrato original (`previous_contract_id`) — nunca altera o
  PDF/registro original.
- **Duplicar**: copia qualquer contrato (rascunho ou finalizado) como um novo
  rascunho independente, sem vínculo de substituição.

## Placeholders

Lista **fechada** — um modelo só pode usar os tokens abaixo; qualquer outro
`{{TOKEN}}` é rejeitado ao salvar (`services/contractService.js`,
`validateTemplateContent`). A resolução é substituição literal de string
(nunca `eval`/`Function`/template engine), então um placeholder nunca executa
código.

| Grupo | Placeholders |
| --- | --- |
| Contratada | `CONTRATADA_RAZAO_SOCIAL`, `CONTRATADA_NOME_FANTASIA`, `CONTRATADA_DOCUMENTO`, `CONTRATADA_ENDERECO`, `CONTRATADA_REPRESENTANTE`, `CONTRATADA_REPRESENTANTE_DOCUMENTO`, `CONTRATADA_EMAIL`, `CONTRATADA_TELEFONE` |
| Cliente | `CLIENTE_RAZAO_SOCIAL`, `CLIENTE_NOME_FANTASIA`, `CLIENTE_DOCUMENTO`, `CLIENTE_EMAIL`, `CLIENTE_TELEFONE`, `CLIENTE_DOMINIO`, `CLIENTE_ENDERECO`, `CLIENTE_REPRESENTANTE`, `CLIENTE_REPRESENTANTE_EMAIL` |
| Plano | `PLANO_NOME`, `PLANO_PRECO`, `PLANO_PERIODICIDADE`, `PLANO_DESCRICAO`, `PLANO_LIMITE_USUARIOS`, `PLANO_LIMITE_UNIDADES`, `PLANO_RECURSOS` |
| Contrato | `CONTRATO_NUMERO`, `CONTRATO_DATA`, `CONTRATO_INICIO`, `CONTRATO_VENCIMENTO`, `CONTRATO_DURACAO_MESES`, `CONTRATO_VALOR_TOTAL`, `CONTRATO_FORMA_PAGAMENTO`, `CONTRATO_FORO` |

A tela de edição de modelo mostra a lista completa em um painel lateral
("Campos disponíveis"), com um botão que insere o token na posição do cursor.

**Gaps conhecidos do schema atual** (não fabricados, refletidos honestamente
no placeholder): `plans` não tem um limite de usuários próprio (só
`max_units`) — `PLANO_LIMITE_USUARIOS` sempre resolve como "Não aplicável
neste plano"; `tenants` não tem campo de endereço — `CLIENTE_ENDERECO` fica
vazio quando não preenchido em outro lugar.

### Campos obrigatórios para finalizar

`CONTRATADA_RAZAO_SOCIAL`, `CONTRATADA_DOCUMENTO`, `CLIENTE_RAZAO_SOCIAL`,
`CLIENTE_DOCUMENTO`, `CLIENTE_REPRESENTANTE`, `PLANO_NOME`,
`CONTRATO_VALOR_TOTAL`, `CONTRATO_INICIO`, `CONTRATO_VENCIMENTO`. Um rascunho
pode ser salvo mesmo incompleto (ex.: empresa sem documento); `POST
/contracts/:id/finalize` bloqueia com `400` até que todos existam e não haja
nenhum `{{TOKEN}}` não resolvido sobrando no texto.

## Valores financeiros

Sempre em **centavos** (nunca float). Periodicidade de cobrança
(`billing_periodicity`): `MONTHLY`, `QUARTERLY`, `SEMIANNUAL`, `ANNUAL` (o
subtotal é `preço mensal do plano × multiplicador`) ou `CUSTOM` (o
desenvolvedor informa o subtotal diretamente). `total = subtotal - desconto +
implantação`.

## PDF

Gerado com **PDFKit** (`services/contractPdfService.js`) — biblioteca puro
Node, sem Chromium/Puppeteer. Foi a escolha mais estável para o ambiente do
Render (sem depender de instalar/versionar um binário de navegador headless),
ao custo de um layout mais simples que HTML+Puppeteer permitiria. Contém
logo (se cadastrada), número do contrato, título, corpo paginado, rodapé com
paginação e blocos de assinatura (contratada/contratante). É renderizado a
partir do **snapshot congelado** do contrato (`provider_snapshot_json` +
`content`), nunca dos dados "ao vivo".

**Assinatura digitalizada**: se uma imagem for cadastrada em Configurações
da contratada, ela é carimbada automaticamente sobre a linha "CONTRATADA" —
o PDF já sai do "Finalizar" com a assinatura da PapiCore aplicada, sem
nenhum passo manual. A assinatura da CONTRATANTE continua manual (não temos
essa imagem).

**Cuidado com rodapé/paginação no PDFKit**: escrever com `doc.text()` numa
posição Y além de `doc.page.maxY()` (`page.height - margins.bottom`) aciona
a paginação automática do PDFKit **mesmo com x/y explícitos** — o rodapé
"foge" para uma página nova em branco em vez de ficar na página certa. A
correção usada aqui é zerar `doc.page.margins.bottom` só durante a escrita
do rodapé (e restaurar em seguida); qualquer nova área de desenho dentro da
margem inferior precisa do mesmo cuidado.

## Armazenamento

```
DATA_DIR/contracts/<ano>/tenant_XXXX/<numero>.pdf
```

Nunca em `public/`. `utils/contractStorage.js` resolve o caminho salvo no
banco (`pdf_path`, relativo a `CONTRACTS_ROOT`) sempre confirmando que o
resultado final continua dentro de `CONTRACTS_ROOT` (bloqueia path
traversal) — o mesmo padrão de `services/backupService.js` para
`BACKUPS_ROOT`. Nenhum caminho vindo do frontend é aceito; o PDF é sempre
localizado pelo registro do contrato no banco.

**Download pelo desenvolvedor**: `GET /api/developer/contracts/:id/download`
exige `requireDeveloper`. **Download pelo cliente**: a própria empresa vê e
baixa os contratos dela (menos rascunhos) na aba "Contrato" do painel
administrativo (`GET /api/admin/contracts` + `GET
/api/admin/contracts/:id/download`), sempre restrito a `req.tenant.id`
resolvido pelo `tenantMiddleware` a partir do usuário autenticado — nunca por
um id vindo da URL. Nenhuma das duas rotas serve a pasta como estática.

## Backup e restauração

- **Backup por empresa** (`services/backupService.js`, `createTenantBackup`):
  os PDFs de contrato da empresa (`contractStorage.listTenantContractFiles`)
  entram no ZIP junto com o banco e os assets, e o `manifest.json` ganha uma
  seção `contracts` (quantidade, caminho relativo e SHA-256 de cada arquivo).
- **Exclusão de empresa** (`deleteTenant`): os registros de `contracts` saem
  junto pelo `ON DELETE CASCADE` (`tenant_id`); os PDFs em disco são
  removidos via `removeTenantContracts`, mesmo padrão de
  `removeTenantAssets`.
- **Restauração — limitação proposital desta fase**: a restauração de um
  tenant **não recria automaticamente** as linhas de `contracts` no banco
  central (elas nunca fazem parte do banco por-tenant que a restauração
  troca). O ZIP preserva os PDFs para que nada se perca, mas religar esses
  arquivos a registros de contrato após uma restauração é uma etapa manual
  nesta fase — não implementada, para não arriscar misturar contratos de
  janelas de tempo diferentes sem uma revisão humana.

## Assinatura (preparação futura)

Campos já existem no schema (`signature_status`, `provider_signed_at`,
`client_signed_at`) mas **nenhum provedor de assinatura eletrônica está
integrado nesta fase** — o fluxo atual é assinatura manual (o PDF já sai com
os blocos de assinatura das duas partes).

## Logs de auditoria

`activity_logs`, mesma tabela/`logActivity()` do resto do painel:
`CONTRACT_COMPANY_SETTINGS_UPDATED`, `CONTRACT_TEMPLATE_CREATED`,
`CONTRACT_TEMPLATE_UPDATED`, `CONTRACT_DRAFT_CREATED`, `CONTRACT_FINALIZED`,
`CONTRACT_PDF_GENERATED`, `CONTRACT_DOWNLOADED`, `CONTRACT_CANCELLED`,
`CONTRACT_RENEWAL_CREATED`, `CONTRACT_ADDENDUM_CREATED`. O conteúdo integral
do contrato e documentos pessoais além do necessário nunca entram no log
(`details` guarda só um resumo curto).

## API

Base: `/api/developer` (exige `Authorization: Bearer <token>` de um usuário
`role = developer`). Rotas de caminho fixo (`company-settings`, `meta`,
`preview`, `current`) são registradas **antes** das rotas com `:id` em
`routes/developerRoutes.js`, para nunca serem interpretadas como um
identificador.

| Método | Rota | Descrição |
| --- | --- | --- |
| GET/PUT | `/contracts/company-settings` | Dados da contratada (singleton) |
| GET/POST/DELETE | `/contracts/company-settings/logo` | Logo usada no PDF |
| GET/POST/DELETE | `/contracts/company-settings/signature` | Assinatura carimbada no PDF |
| GET | `/contracts/meta` | Enums (tipos, status, periodicidades, placeholders) |
| GET | `/contract-templates` | Todas as versões de todos os modelos |
| GET | `/contract-templates/current` | Só a versão padrão de cada família |
| POST | `/contract-templates` | Cria uma nova família (v1) |
| GET/PUT | `/contract-templates/:id` | Detalhe / cria nova versão da família |
| POST | `/contract-templates/:id/duplicate` | Duplica como nova família |
| POST | `/contract-templates/:id/default` | Marca essa versão como padrão |
| POST | `/contract-templates/:id/active` | Ativa/inativa a família inteira |
| GET | `/contracts` | Lista (filtros: `tenant_id`, `status`, `contract_type`, `q`) |
| POST | `/contracts/preview` | Prévia (não persiste nada) |
| POST | `/contracts` | Cria rascunho (numeração transacional) |
| GET/PUT | `/contracts/:id` | Detalhe / edita rascunho |
| POST | `/contracts/:id/finalize` | Finaliza + gera PDF |
| GET | `/contracts/:id/download` | Download protegido do PDF |
| POST | `/contracts/:id/duplicate` | Duplica como novo rascunho |
| POST | `/contracts/:id/renewal` | Gera renovação (rascunho vinculado) |
| POST | `/contracts/:id/addendum` | Gera aditivo (rascunho vinculado) |
| POST | `/contracts/:id/cancel` | Cancela (só `FINALIZED`) |

Somente `role = developer` acessa qualquer uma dessas rotas.

**Painel da empresa cliente** (`/api/admin`, autenticação normal do tenant,
sempre restrito a `req.tenant.id`):

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/contracts` | Lista os contratos da própria empresa (sem rascunhos) |
| GET | `/contracts/:id/download` | Download do PDF (só se pertencer ao tenant e não for `DRAFT`) |

## Editor de texto

A primeira versão usa **textarea simples** (texto puro), não um editor rico.
Isso evita ter que sanitizar HTML/scripts no backend: como nada além de texto
é aceito, não existe superfície para `<script>`, `iframe` ou `javascript:`
dentro do conteúdo do contrato. Um editor rico com formatação seria uma
melhoria futura, exigindo sanitização server-side antes de armazenar.

## Testes

`scripts/testContractSystem.js` roda em `DATA_DIR` isolado (mesmo padrão de
`scripts/testBackupSystem.js`): cria empresa e plano descartáveis, cadastra
modelo, gera prévia, cria rascunho, finaliza, confere o PDF e o hash,
duplica, renova, gera aditivo e cancela — sem tocar em dados reais.

## Limitações conhecidas / próximos passos

- `PLANO_LIMITE_USUARIOS` não tem fonte real no schema de planos.
- A "assinatura" é uma imagem estática carimbada no PDF, não uma assinatura
  eletrônica com validade jurídica/cadeia de custódia — sem integração com
  provedor de assinatura (campos preparados: `signature_status`,
  `provider_signed_at`, `client_signed_at`).
- Editor de texto simples (sem formatação rica).
- Restauração não religa PDFs de contrato a registros automaticamente.
- Texto do modelo inicial precisa de revisão jurídica antes de uso comercial
  (inclui prazo mínimo de 6 meses e multa de 1 mensalidade por rescisão
  antecipada — confirme se esses termos refletem a política comercial atual
  antes de usar com clientes reais).
