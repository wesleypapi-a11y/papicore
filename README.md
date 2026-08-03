# PapiCore

Plataforma SaaS multiempresa de agendamentos. A TorqueDetail é o primeiro cliente cadastrado, mas a aplicação foi estruturada para atender várias empresas em uma única instalação. O domínio institucional da plataforma é `papicore.com.br` e o endereço técnico adotado para a aplicação é `app.papicore.com.br`.

O procedimento completo para implantar e entregar uma nova empresa está em [GUIA_ONBOARDING_CLIENTE.md](GUIA_ONBOARDING_CLIENTE.md).

## Domínio e hospedagem

Você precisa manter **uma hospedagem/servidor da PapiCore**, disponível 24 horas por dia. Não é necessário contratar um servidor para cada cliente: todas as empresas usam a mesma aplicação e o sistema seleciona o banco correto pelo domínio acessado.

Cada cliente deve usar seu próprio domínio personalizado. Pode ser um subdomínio, por exemplo `agenda.torquedetail.com.br`, apontado por CNAME para `app.papicore.com.br`, ou o domínio raiz, como `torquedetail.com.br`, apontado conforme as instruções do provedor de hospedagem. O endereço técnico da PapiCore fica oculto para o consumidor final.

Em qualquer opção, o domínio exato precisa estar cadastrado e marcado como verificado no painel `/desenvolvedor` em **Empresas > Domínios**.

## Estrutura dos dados

- `data/papi_core.db`: cadastro da plataforma, empresas, usuários, planos e domínios;
- `data/tenants/tenant_XXXX_slug.db`: agenda, clientes, serviços e configurações isolados de cada empresa.

O isolamento é lógico e físico por arquivo, mas todos os arquivos vivem no mesmo servidor. Por isso, a pasta `data/` precisa estar em disco persistente e ter backup periódico.

## Publicação recomendada

1. Contrate uma hospedagem Node.js que aceite armazenamento persistente. Render, Railway, Fly.io ou uma VPS podem servir, desde que o disco não seja apagado nos deploys.
2. No DNS de `papicore.com.br`, crie o host `app` apontando para a hospedagem e habilite HTTPS para `app.papicore.com.br`.
3. Configure as variáveis de `.env.example` no painel da hospedagem. Nunca envie o arquivo `.env` real ao repositório.
4. Monte um disco persistente na pasta absoluta correspondente a `data/`.
5. Cadastre na hospedagem todos os domínios personalizados que deverão receber HTTPS.
6. No painel da PapiCore, cadastre o mesmo domínio na empresa correta e marque-o como verificado somente depois de conferir o DNS.

Para a TorqueDetail, defina `TORQUE_DETAIL_DOMAIN` com o domínio próprio que será realmente usado.

## Execução local

```bash
npm install
copy .env.example .env
npm run dev
```

Em desenvolvimento, `http://localhost:3000` abre a empresa definida em `DEFAULT_TENANT_SLUG` (por padrão, `torque-detail`). O painel administrativo fica em `/admin` e o painel da PapiCore em `/desenvolvedor`.

## Produção

Use `npm start` com `NODE_ENV=production`. São obrigatórios:

- `JWT_SECRET` forte e aleatório;
- `DEVELOPER_EMAIL` e `DEVELOPER_PASSWORD`;
- credenciais administrativas sem valores padrão;
- disco persistente para `data/`;
- HTTPS nos domínios públicos;
- rotina externa de backup do disco.
