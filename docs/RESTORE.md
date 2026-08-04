# Restauração de backups — PapiCore (Fase 2)

Restauração **automática** de backup local por empresa (tenant), disparada pelo
painel do desenvolvedor, com validação rígida do ZIP, modo de manutenção durante
a operação, backup de segurança do estado atual e rollback automático em caso de
falha.

**Escopo desta fase:** restaurar o banco + assets de uma empresa a partir de um
backup `SUCCESS` existente; histórico de restaurações (`restore_runs`); consulta
do status de manutenção por empresa.

**Fora de escopo (fases futuras):** criptografia do ZIP, restauração a partir de
armazenamento externo (S3/R2), restauração seletiva (apenas banco ou apenas
assets).

## Como funciona

1. O desenvolvedor escolhe um backup `SUCCESS` da empresa e confirma digitando
   `RESTAURAR` no modal.
2. O serviço **valida o ZIP primeiro**: estrutura (EOCD/CEN/LOC, sem ZIP64),
   `manifest.json` (mesma empresa, versão compatível), conjunto de entries
   **exatamente igual** ao manifest, sem path traversal nem entradas duplicadas,
   métodos `stored` (0) ou `deflate` (8), hash SHA-256 de cada asset e do banco,
   e `PRAGMA integrity_check` da cópia extraída. **Nada é alterado antes dessa
   validação.**
3. A empresa entra em **modo de manutenção** (rotas públicas e admin respondem
   `503` com aviso; o painel do desenvolvedor segue acessível).
4. Um **backup de segurança do estado atual** é gerado (`TENANT_PRE_RESTORE`),
   fora da retenção e sem ser bloqueado pelo próprio modo de restauração.
5. Troca **atômica** do banco: conexão do tenant é fechada, sidecars `-wal`/`-shm`
   removidos, o banco vivo é renomeado para `_aside`, a cópia validada assume o
   lugar e a conexão é reaberta (rodando `upgradeSchema`). Em falha, o banco
   antigo é reposicionado.
6. Os **assets** do ZIP são instalados (os atuais são removidos antes).
7. Sucesso: `restore_runs` → `SUCCESS`, manutenção desligada e o backup de
   segurança é **removido** (o registro fica como `DELETED` para auditoria).
8. Falha após a troca do banco (ex.: assets): **rollback automático** reaplica o
   backup de segurança e tenta devolver o estado anterior → `ROLLBACK_SUCCESS`
   (manutenção desligada) ou `ROLLBACK_FAILED` (empresa **permanece em manutenção**
   de propósito, pois pode haver dados parcialmente inconsistentes).
9. Falha antes da troca do banco: `FAILED` sem tocar os dados atuais.

## Tipos de backup de segurança (`backup_type`)

| Tipo                 | Origem                                        | Retenção |
| -------------------- | --------------------------------------------- | -------- |
| `TENANT_PRE_RESTORE` | Estado atual antes de uma restauração         | Ignorada (removido ao final do fluxo) |

## Estado das restaurações (`status`)

`PENDING`, `RUNNING`, `SUCCESS`, `FAILED`, `ROLLBACK_RUNNING`, `ROLLBACK_SUCCESS`,
`ROLLBACK_FAILED`.

- `ROLLBACK_FAILED` mantém a manutenção **ligada** (decisão proposital: a empresa
  não pode servir dados possivelmente inconsistentes).
- `PENDING` está reservado para fluxos futuros (agendamento); ainda não é usado.

## API

Base: `/api/developer` (exige `Authorization: Bearer <token>` do desenvolvedor).

| Método | Rota                                             | Descrição                                            |
| ------ | ------------------------------------------------ | ---------------------------------------------------- |
| POST   | `/api/developer/backups/:backupId/restore`       | Restaura o backup (201; validações: 400/404/409/503) |
| GET    | `/api/developer/restores`                        | Lista histórico (`?tenant_id=` filtra)               |
| GET    | `/api/developer/restores/:restoreId`             | Detalhe de uma restauração                           |
| POST   | `/api/developer/restores/:restoreId`             | Nova tentativa a partir do mesmo backup (201)        |
| GET    | `/api/developer/tenants/:tenantId/maintenance`   | Status de manutenção da empresa                      |

Códigos de erro principais:

- `400` — backup pertence a outra empresa; ZIP adulterado (hash divergente,
  entry inesperado, path traversal, manifest ausente/errado); ZIP64; tamanho
  acima dos limites.
- `404` — backup/empresa/restauração não encontrados.
- `409` — backup não está `SUCCESS`; já existe restauração em andamento; há um
  backup em andamento para a empresa.
- `503` — a empresa está em manutenção (rotas públicas e admin).

O retry (`POST /restores/:restoreId`) rejeita com `409` se a restauração ainda
está `RUNNING`/`ROLLBACK_RUNNING`. Ele cria um **novo** registro `RUNNING`; o
registro anterior permanece no histórico.

## Modo de manutenção

Durante a restauração, `tenant_maintenance` é marcado com `active=true` e
`reason="Restauração de backup (<restoreId>)"`. Os middlewares de tenant e de
domínio respondem `503` com:

```json
{ "error": "Manutenção em andamento. Tente novamente em instantes.", "maintenance": true }
```

O painel do desenvolvedor (aba Backups e Recuperação) mostra o status da empresa
e permite nova tentativa após `FAILED`/`ROLLBACK_FAILED`.

## Limites de segurança

| Variável                     | Padrão | Descrição                                  |
| ---------------------------- | ------ | ------------------------------------------ |
| `RESTORE_MAX_ZIP_MB`         | `512`  | Tamanho máximo do ZIP de backup            |
| `RESTORE_MAX_UNCOMPRESSED_MB`| `2048` | Tamanho máximo total dos entries descompactados |

Regras aplicadas ao parser ZIP do `restoreService`:

- Entradas com tamanho `0xFFFFFFFF` (ZIP64) são **rejeitadas**.
- Nomes normalizados sem path traversal; entrada duplicada rejeitada.
- O conjunto de entries deve bater **exatamente** com o `manifest.json`.
- O conteúdo de cada entry é verificado por hash SHA-256 do manifest e tamanho
  real do CEN.
- O banco extraído passa por `PRAGMA integrity_check` antes da troca.

## Salvaguardas

- **Validação antes de qualquer mudança:** um ZIP corrompido/adulterado gera
  `FAILED` sem criar backup de segurança nem tocar o banco vivo.
- **Backup de segurança sempre presente:** após a validação, o estado atual é
  congelado em `TENANT_PRE_RESTORE` antes da troca; é a base do rollback.
- **Troca atômica com reversão:** se a reabertura/integridade do banco novo
  falhar, o banco antigo é recolocado (caso não recuperável →
  `INSTALL_UNRECOVERABLE` e restauração falha com rollback).
- **Trava por empresa:** uma restauração por vez por tenant; backups são
  bloqueados durante a restauração (`409`) e restaurações bloqueadas durante um
  backup em andamento.
- **Histórico auditável:** eventos `RESTORE_STARTED`, `RESTORE_PRE_BACKUP_SUCCESS`,
  `RESTORE_SUCCESS`, `RESTORE_FAILED`, `RESTORE_ROLLBACK_STARTED`,
  `RESTORE_ROLLBACK_SUCCESS`, `RESTORE_ROLLBACK_FAILED` em `logs`.

## Testes

```bash
node scripts/testBackupSystem.js   # 25 testes (geração/validação de ZIP)
node scripts/testRestoreSystem.js  # 15 testes (restauração/rollback)
```

`testRestoreSystem.js` roda em um `DATA_DIR` temporário e valida: manutenção por
empresa, restauração bem-sucedida (dados + assets + limpeza do pré-restore),
503 durante a operação, backups de outra empresa/excluídos/arquivo ausente,
travas de concorrência (409), ZIPs adulterados (hash divergente, entry
inesperado, path traversal, manifest ausente/de outra empresa), histórico
sanitizado, rollback automático, rollback falho mantendo manutenção e nova
tentativa.

Variáveis extras:

```bash
# Reutiliza um diretório de dados (em vez de criar um temporário)
TEST_DATA_DIR=/caminho/existente node scripts/testRestoreSystem.js
# Não remove o DATA_DIR ao final (inspeção manual)
KEEP_DATA_DIR=1 node scripts/testRestoreSystem.js
```
