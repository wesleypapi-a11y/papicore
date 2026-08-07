# Evolution API â€” readiness

## VersÃ£o-alvo e alerta de compatibilidade

O adapter implementa o contrato da linha Evolution API v2 (Baileys): criaÃ§Ã£o
por `POST /instance/create`, QR por `GET /instance/connect/{name}` e envio por
`POST /message/sendText/{name}`. A imagem da VPS deve ser fixada por tag e nunca
usar `latest`. A partir da linha 2.4 existe mudanÃ§a de ativaÃ§Ã£o/licenciamento;
antes de instalar, decida explicitamente entre uma release 2.3.x compatÃ­vel e
uma 2.4.x ativada, e repita a suíte contra essa imagem.

ReferÃªncias oficiais: documentaÃ§Ã£o v2 em https://doc.evolution-api.com/v2/ e
releases em https://github.com/EvolutionAPI/evolution-api/releases.

## Contrato HTTP central

Todas as chamadas usam `Content-Type: application/json` e o header `apikey`.
O timeout padrÃ£o Ã© 10 s. Respostas nÃ£o JSON sÃ£o limitadas e erros sÃ£o
sanitizados.

| OperaÃ§Ã£o | MÃ©todo e rota | Corpo principal | Resposta normalizada |
|---|---|---|---|
| Listar/testar | `GET /instance/fetchInstances` | â€” | lista de nome/estado |
| Criar | `POST /instance/create` | `instanceName`, `integration: WHATSAPP-BAILEYS`, `qrcode` | instÃ¢ncia/QR |
| QR/conectar | `GET /instance/connect/{name}` | â€” | `base64`, `code` ou `pairingCode` |
| Estado | `GET /instance/connectionState/{name}` | â€” | `open`, `connecting` ou `close` |
| Texto | `POST /message/sendText/{name}` | `number`, `text` | `key.id` |
| Imagem/arquivo | `POST /message/sendMedia/{name}` | `number`, `mediatype`, `media`, legenda/nome | `key.id` |
| Webhook | `POST /webhook/set/{name}` | objeto `webhook` com URL, headers e eventos | configuraÃ§Ã£o |
| Logout/desconectar | `DELETE /instance/logout/{name}` | â€” | confirmaÃ§Ã£o |
| Excluir | `DELETE /instance/delete/{name}` | â€” | confirmaÃ§Ã£o |

NÃ£o existe endpoint separado de "disconnect" no contrato v2 adotado: a aÃ§Ã£o
de desconectar o aparelho Ã© implementada por `logout`; excluir remove a
instÃ¢ncia. DiferenÃ§as observadas em releases antigas incluem criaÃ§Ã£o com nome
na URL, integraÃ§Ã£o chamada apenas `WHATSAPP` e corpos de webhook sem o wrapper
`webhook`; esses formatos nÃ£o devem ser misturados no adapter atual.

## Checklist antes da VPS

- Escolher e fixar tag/sha da Evolution.
- Confirmar requisitos de licenÃ§a da tag escolhida.
- Criar DNS/TLS para Evolution e para o webhook PapiCore.
- Guardar API key em secret manager e rotacionÃ¡-la apÃ³s homologação.
- Restringir firewall; nÃ£o expor banco/Redis.
- Validar os nove endpoints acima contra servidor local de homologação.
- Testar QR, expiraÃ§Ã£o, reconnect, logout e remoÃ§Ã£o.
- Testar 401, 404, 409, 422, 429, 500 e timeout.
- Testar webhook assinado e isolamento com dois tenants.
- Confirmar backup e monitoramento da Evolution.
- Somente entÃ£o mudar `WHATSAPP_PROVIDER=evolution` e `WHATSAPP_ENABLED=true`.

## Lacunas deliberadamente restantes

O segredo salvo pelo painel ainda reside no SQLite core em texto simples; em
produÃ§Ã£o prefira fornecÃª-lo exclusivamente por variável de ambiente/secret
manager. A interface ainda nÃ£o oferece reconciliaÃ§Ã£o completa de instÃ¢ncias
Ã³rfÃ£s nem uma instÃ¢ncia central `papicore_support`. Esses itens nÃ£o impedem a
homologaÃ§Ã£o de envio, mas impedem declarar operaÃ§Ã£o de larga escala pronta.

