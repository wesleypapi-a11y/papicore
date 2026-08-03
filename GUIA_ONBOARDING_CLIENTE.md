# Guia PapiCore: da venda à entrega do sistema

Este é o procedimento padrão para implantar a PapiCore para um novo cliente usando o domínio próprio dele.

## 1. Fechamento da venda

Antes de iniciar o trabalho, registre por escrito:

- nome empresarial e nome que aparecerá no sistema;
- plano contratado, preço, vencimento e forma de pagamento;
- valor da implantação e o que está incluído;
- quem paga domínio, hospedagem, WhatsApp e serviços externos;
- prazo estimado, contado após o cliente entregar todos os materiais;
- política de suporte, cancelamento, exportação e exclusão dos dados;
- autorização para tratar dados de clientes e enviar mensagens;
- responsável do cliente que aprovará a entrega.

Defina também quem será o titular do domínio. O mais seguro é registrar o domínio nos dados do cliente e receber acesso técnico para administrá-lo. Se a PapiCore registrar em nome próprio, o contrato deve explicar propriedade, renovação, transferência e o que acontece no cancelamento.

## 2. Coleta de informações

Envie ao cliente uma ficha solicitando:

- razão social, nome fantasia e CPF/CNPJ;
- nome, e-mail e WhatsApp do responsável;
- domínio desejado e duas alternativas;
- logo em PNG ou SVG, preferencialmente com fundo transparente;
- cores e identidade visual;
- telefone, WhatsApp, endereço e Instagram;
- serviços, descrições, preços e duração;
- dias e horários de funcionamento;
- intervalo de almoço e dias sem atendimento;
- quantidade de atendimentos simultâneos;
- unidades e modalidades de atendimento;
- formas de pagamento;
- mensagem exibida após o agendamento;
- nome e e-mail do administrador do sistema.

Não peça senhas por WhatsApp. Crie uma senha temporária forte e solicite a troca no primeiro acesso.

## 3. Compra e organização do domínio

1. Consulte a disponibilidade do domínio aprovado.
2. Confirme a grafia com o cliente antes da compra.
3. Registre preferencialmente no CPF/CNPJ e e-mail do cliente.
4. Ative renovação automática e autenticação em dois fatores.
5. Registre em local seguro: provedor, titular, data de renovação e contato responsável.
6. Não compartilhe a senha principal do registrador; use acesso delegado quando o provedor oferecer essa opção.

Para preservar um site institucional existente, prefira um subdomínio como `agenda.empresa.com.br`. Se o domínio inteiro for exclusivo para a agenda, pode ser usado `empresa.com.br`.

## 4. Cadastro do cliente na PapiCore

No domínio técnico da plataforma, acesse:

```text
https://app.papicore.com.br/desenvolvedor
```

Depois:

1. Crie a empresa com nome, documento, contato, plano, status `ACTIVE` e vencimento.
2. Confirme que foi criado um banco exclusivo para ela.
3. Crie o usuário proprietário (`owner`) com o e-mail administrativo do cliente.
4. Cadastre o domínio final exatamente como será acessado, sem `https://`, caminho ou barra. Exemplo: `agenda.empresa.com.br`.
5. Mantenha o domínio como não verificado até concluir DNS e HTTPS.
6. Registre a cobrança inicial e a mensalidade no financeiro da PapiCore.

Não reutilize e-mail de administrador entre empresas, pois os usuários da plataforma possuem e-mail único.

## 5. Apontamento do DNS

### Opção recomendada: subdomínio

No painel DNS do domínio do cliente, crie:

```text
Tipo: CNAME
Nome/Host: agenda
Destino/Valor: app.papicore.com.br
TTL: automático ou 3600
```

O resultado será `agenda.empresa.com.br`. Não inclua `https://` nem barras no destino.

### Domínio raiz

Para usar `empresa.com.br`, siga o método aceito pela hospedagem:

- registro A apontando para o IP público do servidor; ou
- ALIAS/ANAME/CNAME flattening apontando para o endereço fornecido pela hospedagem.

Evite substituir registros do site ou e-mail já existentes. Antes de alterar DNS, salve uma captura ou exportação da zona atual. Registros MX, SPF, DKIM e DMARC não devem ser removidos.

### Endereço com `www`

Se o cliente também usar `www.empresa.com.br`, cadastre e configure esse host separadamente ou redirecione-o para o domínio principal. Na PapiCore, `www` é normalizado para o domínio sem `www`, mas a hospedagem ainda precisa aceitar o host e emitir o certificado HTTPS correspondente.

## 6. Cadastro do domínio na hospedagem

Além do DNS, adicione o domínio do cliente como domínio personalizado no serviço onde a PapiCore está hospedada:

1. Abra as configurações de domínio do serviço PapiCore.
2. Adicione `agenda.empresa.com.br` ou o domínio escolhido.
3. Aguarde a hospedagem confirmar o DNS.
4. Ative ou aguarde a emissão automática do certificado SSL/TLS.
5. Confirme que o endereço abre com `https://` sem alerta de segurança.

DNS correto sem domínio cadastrado na hospedagem pode causar erro de certificado ou página não encontrada.

## 7. Verificação e identidade visual

Quando DNS e HTTPS estiverem funcionando:

1. Volte ao painel `/desenvolvedor`.
2. Abra a empresa e marque o domínio como verificado.
3. Acesse `https://dominio-do-cliente/admin`.
4. Entre com o usuário proprietário.
5. Em **Configurações**, informe nome da empresa, telefone, WhatsApp, URL pública da logo, horários, capacidade e mensagem de confirmação.
6. Cadastre unidades, modalidades, serviços, preços, duração e bloqueios.
7. Confira se título, logo, nome e WhatsApp mudaram no agendamento público.

A URL da logo deve usar HTTPS e permanecer publicamente acessível. Não use link temporário de conversa, Drive privado ou arquivo localizado apenas no computador.

## 8. Testes obrigatórios

Faça os testes em celular e computador, preferencialmente também em uma janela anônima:

- domínio abre com HTTPS e sem alertas;
- domínio mostra a empresa correta;
- logo, nome, telefone e WhatsApp estão corretos;
- cliente consegue escolher modalidade, data, serviço e horário;
- preço e duração estão corretos;
- horário ocupado deixa de aparecer como disponível;
- solicitação aparece no painel administrativo;
- administrador consegue aceitar, recusar, editar e concluir;
- bloqueios de agenda funcionam;
- mensagem e link do WhatsApp usam a empresa correta;
- login de uma empresa não funciona no domínio de outra;
- layout funciona em celular e computador;
- reiniciar ou publicar novamente a aplicação não apaga os dados;
- backup da empresa pode ser criado e localizado.

Crie um agendamento de teste claramente identificado e exclua-o após a validação.

## 9. Homologação com o cliente

Faça uma apresentação curta com o responsável e peça que ele valide:

- domínio e identidade visual;
- catálogo e preços;
- horários e capacidade;
- fluxo do agendamento;
- painel administrativo;
- recebimento e tratamento das solicitações.

Registre a aprovação por e-mail ou mensagem. Correções que fazem parte do escopo devem ser concluídas antes da entrega; novas funcionalidades devem virar nova proposta.

## 10. Entrega

Entregue ao cliente:

- endereço público de agendamento;
- endereço `/admin`;
- e-mail do administrador;
- senha temporária por canal separado;
- instrução para alterar a senha;
- guia curto de uso do painel;
- contato e horário do suporte;
- data da próxima cobrança;
- responsável e data de renovação do domínio;
- resumo do que será mantido pela PapiCore.

Nunca entregue a senha do painel do desenvolvedor. Ela administra todas as empresas.

## 11. Rotina após a entrega

Mantenha uma ficha operacional por cliente contendo domínio, hospedagem, plano, vencimentos, contatos e observações, sem registrar senhas em texto aberto.

Rotina mínima:

- diariamente: verificar disponibilidade do servidor e falhas relevantes;
- semanalmente: gerar ou conferir backups fora do mesmo disco do servidor;
- mensalmente: testar restauração de uma cópia, conferir espaço em disco e cobranças;
- antes de cada deploy: criar backup e testar a atualização;
- 30 dias antes: avisar sobre renovação do domínio e serviços externos;
- periodicamente: revisar acessos administrativos e remover usuários que saíram da empresa.

## Checklist rápido de entrega

- [ ] Contrato/proposta e pagamento confirmados
- [ ] Dados e materiais recebidos
- [ ] Domínio registrado com titularidade definida
- [ ] Renovação automática e 2FA ativadas
- [ ] Empresa, plano e proprietário cadastrados
- [ ] Banco exclusivo criado
- [ ] DNS configurado sem afetar e-mail ou site existente
- [ ] Domínio adicionado à hospedagem
- [ ] HTTPS válido
- [ ] Domínio verificado na PapiCore
- [ ] Identidade, serviços e agenda configurados
- [ ] Fluxo completo testado
- [ ] Backup conferido
- [ ] Cliente homologou
- [ ] Acessos e instruções entregues
- [ ] Cobrança e renovação registradas

## Diagnóstico rápido

| Sintoma | Verificação |
|---|---|
| Domínio não abre | Confira propagação, A/CNAME e domínio personalizado na hospedagem |
| Erro de certificado | Aguarde ou reemita o HTTPS depois de confirmar o DNS |
| “Domínio não cadastrado” | Cadastre exatamente o host acessado no painel da PapiCore |
| “Domínio não validado” | Marque como verificado somente após DNS e HTTPS funcionarem |
| Abre a empresa errada | Revise a associação do domínio no painel do desenvolvedor |
| Login recusado | Confirme que usuário e domínio pertencem à mesma empresa |
| Logo não aparece | Use URL pública HTTPS e teste-a em janela anônima |
| Dados somem após deploy | Corrija imediatamente o disco persistente da pasta `data/` |

