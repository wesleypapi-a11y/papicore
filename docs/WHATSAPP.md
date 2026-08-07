# WhatsApp no PapiCore

O mÃ³dulo usa obrigatoriamente o fluxo `controller -> whatsappService -> provider`.
O provider padrÃ£o Ã© `mock`; ele nunca faz acesso de rede e finaliza mensagens
como `SIMULATED`. O provider `evolution` sÃ³ Ã© selecionado quando
`WHATSAPP_ENABLED=true`, `WHATSAPP_PROVIDER=evolution`, URL e chave estÃ£o
configuradas.

## ConfiguraÃ§Ã£o

Consulte `.env.example`. Em produÃ§Ã£o, defina tambÃ©m `PAPICORE_PUBLIC_URL` com
a origem HTTPS pÃºblica. A chave fica somente no backend. Os nomes `EVOLUTION_*`
sÃ£o aliases legados; novas instalaÃ§Ãµes devem usar `WHATSAPP_*`.

## InstÃ¢ncias e isolamento

Cada tenant possui uma linha exclusiva em `evolution_instances` no banco core.
O nome Ã© derivado pelo backend do nome estÃ¡vel do banco do tenant; o frontend
nunca escolhe a instÃ¢ncia. Templates, outbox e histÃ³rico ficam no banco SQLite
exclusivo do tenant. O namespace `papicore_support` fica reservado para uma
futura instÃ¢ncia central e nÃ£o deve ser associado a tenant.

## ConexÃ£o e QR

O backend cria a instÃ¢ncia, registra o webhook HTTPS com token exclusivo e sÃ³
entÃ£o solicita o QR. Respostas base64, cÃ³digo textual e pairing code sÃ£o
normalizadas pelo provider. Ao receber `CONNECTION_UPDATE/open`, o QR salvo Ã©
apagado. QR, API key e token de webhook nÃ£o podem ser escritos em logs.

## Outbox

Eventos de agendamento apenas inserem uma linha `PENDING`. O worker iniciado no
boot percorre bancos por tenant, reivindica atomicamente as linhas, aplica
backoff e registra o resultado no histÃ³rico. Uma falha de WhatsApp nunca desfaz
agendamento, financeiro ou consumo de pacote. Linhas `PROCESSING` abandonadas
por mais de dez minutos sÃ£o recuperadas.

## AtivaÃ§Ã£o

1. Fixe uma tag exata da Evolution e valide o contrato de endpoints.
2. Instale a Evolution sem conectar qualquer conta de produÃ§Ã£o.
3. Configure URL, API key e URL pÃºblica HTTPS.
4. Rode `node scripts/testWhatsappEvolutionReadiness.js` com o servidor mock.
5. Ative primeiro um tenant de homologaÃ§Ã£o e monitore webhook/outbox.

