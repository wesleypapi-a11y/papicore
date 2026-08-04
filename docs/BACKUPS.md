# Backups locais — PapiCore (Fase 1)

Sistema de backup **local** por empresa (tenant) da plataforma PapiCore.

**Escopo desta fase:** gerar, listar, baixar, excluir e reter backups locais em ZIP,
com banco consistente, verificação de integridade, hash SHA-256 e histórico em
`backup_runs`.

**Restauração automática:** implementada na Fase 2 — veja [`RESTORE.md`](./RESTORE.md).

**Fora de escopo (fases futuras):** criptografia do ZIP e envio para
armazenamento externo (S3/R2).

> AVISO: o ZIP contém dados pessoais dos clientes (nomes, telefones, CPFs,
> endereços, placas). Trate-o como dado sensível: restrinja acesso ao disco e
> mova cópias para armazenamento externo.

## O que cada backup contém

1. **Banco SQLite consistente** — snapshot via `VACUUM INTO` (ignora WAL/SHM),
   validado com `PRAGMA integrity_check` (exige `ok`).
2. **Assets da empresa** — logo, favicon, QR do Pix e demais arquivos de
   `DATA_DIR/assets/tenant_XXXX/`.
3. **`manifest.json`** — metadados do backup (tenant, domínio principal, plano,
   hash e integridade do banco, lista de assets com hash, versão do app/schema).

Estrutura no disco:

```
DATA_DIR/
└── backups/
    ├── tenants/tenant_0001/tenant_0001_torque_detail-backup-2026-08-04_03-00-00.zip
    ├── system/                     (reservado)
    └── tmp/<backup-id>/            (temporário, removido ao final)
```

O nome do arquivo é `tenant_XXXX_slug-backup-AAAA-MM-DD_HH-mm-ss.zip`.

## Tipos de backup (`backup_type`)

| Tipo                | Origem                                   |
| ------------------- | ---------------------------------------- |
| `TENANT_MANUAL`     | Painel do desenvolvedor (botão Backup)   |
| `TENANT_AUTOMATIC`  | Rotina diária automática                 |
| `TENANT_PRE_DELETE` | Antes da exclusão definitiva de empresa  |
| `TENANT_PRE_RESTORE`| Estado atual antes de uma restauração (Fase 2; fora da retenção) |

Status de cada registro: `RUNNING`, `SUCCESS`, `FAILED`, `DELETED`.

## API

Base: `/api/developer/backups` (exige `Authorization: Bearer <token>` do
desenvolvedor).

| Método | Rota                                        | Descrição                                   |
| ------ | ------------------------------------------- | ------------------------------------------- |
| POST   | `/api/developer/tenants/:id/backup`         | Gera backup manual (`TENANT_MANUAL`)        |
| GET    | `/api/developer/backups`                    | Lista histórico (`?tenant_id=` filtra)      |
| GET    | `/api/developer/backups/storage`            | Uso do disco + tamanho dos backups          |
| GET    | `/api/developer/backups/:backupId`          | Detalhe de um registro                      |
| GET    | `/api/developer/backups/:backupId/download` | Baixa o arquivo ZIP existente               |
| DELETE | `/api/developer/backups/:backupId`          | Exclui arquivo + marca `DELETED`            |

> `GET /backups/storage` deve ser declarado **antes** de `GET /backups/:backupId`
> na rota (já está), senão a string `storage` é capturada como `backupId`.

O download resolve o caminho **pelo registro do banco** (`relative_path`) e nunca
aceita caminhos do frontend (proteção contra path traversal: só arquivos dentro de
`DATA_DIR/backups`).

## Rotina automática

- Ativa apenas em **produção** com `BACKUP_LOCAL_ENABLED=true`.
- Agenda: `BACKUP_LOCAL_SCHEDULE` (padrão `0 3 * * *`) no fuso `BACKUP_TIMEZONE`.
- Percorre tenants `ACTIVE` e gera `TENANT_AUTOMATIC` para cada um.
- Não roda em paralelo (se uma rodada está ativa, a próxima é ignorada).
- Falha de uma empresa não interrompe as demais.
- Ao final aplica a retenção global.
- `BACKUP_RUN_ON_START=true` executa uma rodada no boot (opcional).

## Retenção

- `BACKUP_LOCAL_RETENTION_DAYS=7` — remove `SUCCESS` mais antigos que N dias.
- `BACKUP_LOCAL_MAX_PER_TENANT=10` — mantém no máximo N por empresa.
- Backup pré-exclusão continua retido após a empresa ser excluída (o `tenant_id`
  do registro vira `NULL` via `ON DELETE SET NULL`); a retenção global também
  limpa esses órfãos por idade/quantidade.
- Registros `RUNNING`/`FAILED` nunca são removidos pela retenção.
- Backups `TENANT_PRE_RESTORE` (Fase 2) também não são podados: são removidos ao
  final do fluxo de restauração (veja [`RESTORE.md`](./RESTORE.md)).

## Exclusão de empresa

A exclusão definitiva de uma empresa **só acontece depois** de um backup
`TENANT_PRE_DELETE` bem-sucedido. Se o backup falhar, a exclusão é **cancelada**
e o evento `TENANT_DELETE_BLOCKED_BY_BACKUP_FAILURE` é registrado.

## Alerta de espaço na aba Backups

O painel do desenvolvedor consulta `GET /backups/storage` e exibe um banner com o
tamanho total dos backups e o nível de uso do disco:

| Nível      | Critério                                                          |
| ---------- | ----------------------------------------------------------------- |
| `ok`       | uso < 70% e espaço livre ≥ `BACKUP_MIN_FREE_SPACE_MB`             |
| `warning`  | uso ≥ 70% (amarelo)                                              |
| `critical` | uso ≥ 85% ou espaço livre abaixo do mínimo (vermelho)            |

Quando não há suporte a `statfs` (filesystems raros), o banner mostra apenas o
tamanho dos backups, sem o nível de disco.

## Produção no Render (Persistent Disk)

O Render **reinicia o disco efêmero a cada deploy**; sem Persistent Disk os
bancos e backups somem. Configure assim:

1. **Crie o Persistent Disk** no dashboard do serviço: montar em `/var/data`
   (limite mínimo de 1 GB; escolha um tamanho com folga para bancos + assets +
   backups).
2. **Variáveis de ambiente** (Settings → Environment):

   ```env
   NODE_ENV=production
   DATA_DIR=/var/data
   BACKUP_LOCAL_ENABLED=true
   BACKUP_LOCAL_SCHEDULE=0 3 * * *
   BACKUP_TIMEZONE=America/Sao_Paulo
   BACKUP_LOCAL_RETENTION_DAYS=7
   BACKUP_LOCAL_MAX_PER_TENANT=10
   BACKUP_RUN_ON_START=false
   BACKUP_MIN_FREE_SPACE_MB=200
   ```

   `DATA_DIR` deve apontar **sempre** para o ponto de montagem do Persistent Disk
   (`/var/data`). Nenhum caminho de backup é hardcoded no código: tudo deriva de
   `DATA_DIR`.
3. **Persistência entre deploys:** como `DATA_DIR=/var/data` vive no Persistent
   Disk, bancos, assets e backups sobrevivem a novos deploys (o teste de
   "restart" valida isso: dois processos com o mesmo `DATA_DIR` preservam os
   backups anteriores).
4. **Espaço:** o limite é de 1 GB por Persistent Disk. A retenção limita os
   backups, mas **baixe uma cópia semanal** para outro local (o Render não
   replica o Persistent Disk) e apague os ZIPs antigos pelo painel ou via
   `DELETE /api/developer/backups/:backupId`. Monitore o banner da aba Backups
   (amarelo ≥ 70%, vermelho ≥ 85%).
5. **Backups em desenvolvimento:** com `NODE_ENV=development` a rotina
   automática permanece desligada (não importa `BACKUP_LOCAL_ENABLED`); backups
   manuais pelo painel continuam funcionando.

## Salvaguardas

- **Espaço em disco:** antes de copiar qualquer coisa, verifica espaço livre
  (`BACKUP_MIN_FREE_SPACE_MB=200`); abaixo do limite → erro `507` e o backup é
  abortado.
- **Trava por empresa:** impede dois backups simultâneos do mesmo tenant
  (clique duplicado, rotina + manual) → `409`.
- **Hash SHA-256** do ZIP gravado no histórico; falha apaga o ZIP parcial e grava
  `FAILED` com a mensagem sanitizada.
- Logs de auditoria: `BACKUP_STARTED`, `BACKUP_SUCCESS`, `BACKUP_FAILED`,
  `BACKUP_DELETED`, `BACKUP_RETENTION_COMPLETED`, `TENANT_PRE_DELETE_BACKUP_SUCCESS`,
  `TENANT_DELETE_BLOCKED_BY_BACKUP_FAILURE`.

## Variáveis de ambiente

| Variável                          | Padrão                | Descrição                                   |
| --------------------------------- | --------------------- | ------------------------------------------- |
| `BACKUP_LOCAL_RETENTION_DAYS`     | `7`                   | Idade máxima (dias) de backups retidos      |
| `BACKUP_LOCAL_MAX_PER_TENANT`     | `10`                  | Máximo de backups por empresa               |
| `BACKUP_LOCAL_ENABLED`            | `true`                | Habilita a rotina automática (produção)     |
| `BACKUP_LOCAL_SCHEDULE`           | `0 3 * * *`           | Cron diário                                 |
| `BACKUP_TIMEZONE`                 | `America/Sao_Paulo`   | Fuso da agenda                              |
| `BACKUP_RUN_ON_START`             | `false`               | Roda uma rodada no boot                     |
| `BACKUP_MIN_FREE_SPACE_MB`        | `200`                 | Espaço mínimo livre exigido (MB)            |

## Testes

```bash
node scripts/testBackupSystem.js
```

Roda em um `DATA_DIR` temporário (não toca os dados reais) e valida: criação do
ZIP, conteúdo (`manifest.json` + banco + assets), integridade do banco extraído,
hash, retenção (quantidade/idade), exclusão, pré-exclusão, órfãos, trava de
concorrência, path traversal, rotina automática, parser de env do scheduler,
preservação de registros `RUNNING`, backup sem assets, assets (logo/favicon),
`getStorageInfo` e persistência entre "deploys" (dois processos com o mesmo
`DATA_DIR`).

Variáveis extras:

```bash
# Reutiliza um diretório de dados (em vez de criar um temporário)
TEST_DATA_DIR=/caminho/existente node scripts/testBackupSystem.js
# Não remove o DATA_DIR ao final (inspeção manual)
KEEP_DATA_DIR=1 node scripts/testBackupSystem.js
```
