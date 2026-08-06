# Pacotes de Serviços — PapiCore (Fase 1)

Módulo para **pré-pagamento de serviços** por empresa (tenant): o cliente compra
um pacote (ex.: "Pacote Básico — 2 lavagens"), ganha um saldo por serviço, e o
saldo é **reservado** ao criar um agendamento, **consumido** na conclusão e
**liberado** em caso de cancelamento/recusa.

**Escopo desta fase:** modelos de pacote; venda ao cliente (find-or-create por
telefone/placa); saldos por serviço; reserva/consumo/liberação atrelados a
agendamentos; baixa/crédito manual com motivo obrigatório; histórico imutável de
movimentações; validade e status; UI no painel `/admin`.

**Fora de escopo (fases futuras):** login do cliente final; WhatsApp; pagamento
online (gateway); assinatura recorrente; transferência de pacote entre clientes
(o modelo `TRANSFER` existe na base, sem interface); reserva automática no site
público (preparada, desativada). O painel do desenvolvedor não foi alterado.

## Entidades

| Tabela | Papel |
|---|---|
| `service_packages` | Modelo de pacote (preço, validade, vínculo a veículo) |
| `service_package_items` | Itens do modelo: `service_id` + `quantity` (`UNIQUE(package_id, service_id)`) |
| `customers` / `vehicles` | Cadastro mínimo criado/atualizado por telefone e placa |
| `customer_packages` | Pacote vendido (snapshots do modelo na venda) |
| `customer_package_balances` | Saldo por serviço do pacote vendido |
| `package_transactions` | Histórico imutável de movimentações (id TEXT PK) |

`appointments` ganhou colunas idempotentes: `payment_source`
(`NORMAL`/`PACKAGE`), `customer_package_id`, `package_balance_id`,
`package_credit_status` (`NONE`/`RESERVED`/`CONSUMED`/`RELEASED`) e
`package_quantity`. `financial_entries` ganhou `customer_package_id` (dedup da
receita da venda).

## Regras de saldo

```
available = total_quantity + adjusted_quantity − reserved_quantity − consumed_quantity
```

`available` nunca é persistido — é calculado na consulta. Toda operação que altera
saldo roda dentro de `db.transaction()` com `UPDATE` condicional e verificação
`>=` (saldo nunca fica negativo). Operações são **idempotentes**: RESERVE/CONSUME/
RELEASE são detectadas por `balance_id + appointment_id` e repetidas viram no-op.

Transações registradas: `PURCHASE`, `RESERVE`, `CONSUME`, `RELEASE`,
`MANUAL_DEBIT`, `MANUAL_CREDIT`, `CANCEL_PACKAGE`, `EXPIRE`, `TRANSFER`.

## Status do pacote vendido

- `ACTIVE` — utilizável.
- `EXHAUSTED` — todos os saldos consumidos.
- `EXPIRED` — calculado via refresh na consulta (`applyExpirations`), sem
  scheduler. Vencido bloqueia **novas** reservas; reservas ativas seguem válidas.
- `CANCELLED` — cancelado (requer motivo; bloqueado com reserva ativa).
- `SUSPENDED` — reservado para uso futuro (sem interface na fase).

## Integração com agendamentos e financeiro

- **Reserva**: ao criar/editar um agendamento com `customer_package_id`, o crédito
  do serviço é reservado; se o pacote não cobre **todos** os serviços do
  agendamento → `"Este pacote não cobre todos os serviços selecionados."`
- **Consumo**: ao marcar o agendamento como `completed`, o crédito reservado vira
  consumo. Conclusão de agendamento `PACKAGE` **não** gera lançamento financeiro.
- **Liberação**: status final não ativo (`cancelled`/`rejected`) ou exclusão do
  agendamento devolvem o crédito. O histórico usa `appointment_id` **sem FK** para
  sobreviver à exclusão do agendamento.
- **Moeda**: `financial_entries.amount` é REAL (legado); o módulo trabalha em
  **centavos**, convertendo na borda. A venda grava a receita integral **uma única
  vez** (dedup por `customer_package_id`); venda gratuita não gera entrada.

## API (`/api/admin`, banco sempre do contexto `req.user.tenant_id`)

- Modelos: `GET/POST /packages`, `PUT /packages/:id`, `PATCH /packages/:id/active`.
- Venda e gestão: `GET/POST /customer-packages`,
  `GET /customer-packages/:id`, `GET /customer-packages/:id/statement`,
  `POST /customer-packages/:id/adjust`, `POST /customer-packages/:id/cancel`.
- Clientes: `GET /customers?search=`, `GET /customers/:id`.
- Agendamento: `POST /appointments/:id/package/reserve`,
  `POST /appointments/:id/package/release`.
- **Papéis**: `owner`/`admin` = gestão completa (modelos, venda, ajuste,
  cancelamento); `employee` = visualiza e usa pacotes em agendamentos
  (reserva/liberação disponíveis a qualquer autenticado).

## Migração

`upgradeSchema` é idempotente e registra o marco `service_packages_v1`
(`migrateServicePackagesV1` faz backfill de `payment_source`,
`package_credit_status` e `package_quantity` nas appointments antigas).
Backup/restore reaplicam `upgradeSchema` automaticamente.

## Testes

`node scripts/testServicePackages.js` — 15/15 cobrindo migração, CRUD, venda +
entrada única em REAL, desconto, reserva/consumo/liberação idempotentes, ajuste
manual, cobertura, expiração, cancelamento, ciclo de agendamento e reuso de
cliente por telefone. Usa tenant descartável em `DATA_DIR` temporário
(`KEEP_DATA_DIR=1` inspeciona).
