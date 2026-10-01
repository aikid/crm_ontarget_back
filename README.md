# OnTarget API

Backend em Node.js, Express, Prisma e PostgreSQL criado a partir dos fluxos existentes no frontend.

## Executar localmente

Requer Node.js 22 ou superior e Docker Desktop (ou Docker Engine com Compose).

```bash
npm install
npm run db:up
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

A API inicia em `http://localhost:3333`. O PostgreSQL de desenvolvimento fica disponível em `localhost:5433`, no banco `ontarget_test`. A conexão fica configurada somente em `backend/.env`; não duplique `DATABASE_URL` em `prisma/.env`.

Comandos úteis:

```bash
npm run db:logs   # acompanhar os logs do PostgreSQL
npm run db:reset  # recriar as tabelas e rodar o seed novamente
npm run db:down   # parar o container sem apagar os dados
```

Para apagar também o volume e todos os dados locais, execute conscientemente `docker compose down -v`.

Para conectar usando DBeaver, DataGrip ou outro cliente:

| Campo | Valor |
|---|---|
| Host | `localhost` |
| Porta | `5433` |
| Banco | `ontarget_test` |
| Usuário | `ontarget` |
| Senha | `ontarget_dev` |

Para usar outro PostgreSQL, substitua a `DATABASE_URL` em `backend/.env`.

```env
DATABASE_URL="postgresql://ontarget:senha@localhost:5432/ontarget?schema=public"
```

Para um banco gerenciado, substitua host, porta, usuário e senha pelos dados fornecidos pelo provedor. Se ele exigir TLS, normalmente a URL também precisará de `sslmode=require`.

## Autenticação e perfis

A autenticação utiliza sessão opaca persistida no PostgreSQL e cookie `HttpOnly`. Requisições autenticadas do navegador precisam usar credenciais, e mutações precisam enviar o `csrfToken` retornado no login/sessão pelo cabeçalho `X-CSRF-Token`.

| Ação | Endpoint |
|---|---|
| Login | `POST /api/auth/login` |
| Sessão atual | `GET /api/auth/session` |
| Logout | `POST /api/auth/logout` |

Usuários criados pelo seed, todos com a senha definida por `SEED_PASSWORD` — `OnTarget@123` apenas no ambiente local:

| Perfil | E-mail |
|---|---|
| Gestor | `carlos@ontarget.com.br` |
| SDR | `ana@ontarget.com.br` |
| Portal do Cliente | `ricardo@brasaldemo.com.br` |

Os perfis internos podem acessar dados operacionais de todos os clientes conforme sua função. O perfil `CLIENT` é sempre limitado ao `clientId` da sessão no backend.

## Cadastros da V1

Os cadastros seguem a hierarquia `Cliente → Loja → Campanha → Lead`. Cada campanha pertence a uma única loja, e chaves compostas no PostgreSQL impedem que loja, campanha e lead sejam associados a clientes diferentes.

Somente o perfil `GESTOR` pode acessar `/api/admin`. Clientes, lojas e usuários usam desativação lógica; registros operacionais não são apagados.

| Recurso | Listar | Criar | Atualizar / ativar |
|---|---|---|---|
| Clientes | `GET /api/admin/clients` | `POST /api/admin/clients` | `PATCH /api/admin/clients/:id` |
| Lojas | `GET /api/admin/stores` | `POST /api/admin/stores` | `PATCH /api/admin/stores/:id` |
| Campanhas | `GET /api/admin/campaigns` | `POST /api/admin/campaigns` | `PATCH /api/admin/campaigns/:id` |
| Usuários | `GET /api/admin/users` | `POST /api/admin/users` | `PATCH /api/admin/users/:id` |

Campanhas aceitam os status `ACTIVE`, `INACTIVE` e `COMPLETED`. Uma campanha só pode ser ativada quando seu cliente e sua loja estão ativos. Usuários do perfil `CLIENT` obrigatoriamente precisam de um cliente ativo.

## Importação de leads

Somente Gestores podem importar. O endpoint `POST /api/admin/imports` recebe `multipart/form-data` com `clientId`, `storeId`, `campaignId` e o campo de arquivo `file`.

O modelo aceita CSV ou XLSX com as colunas fixas:

| Coluna | Regra |
|---|---|
| `nome` | Obrigatória |
| `telefone` | Obrigatória; normalizada para E.164 |
| `veículo` | Obrigatória |
| `origem` | Obrigatória |
| `motivo` | Opcional |

- Limite de 10 MB e 10.000 linhas por lote.
- Telefones repetidos no arquivo ou já existentes na campanha são rejeitados.
- Linhas válidas são importadas mesmo quando outras linhas possuem erros.
- Cada lote mantém totais e erros por linha em `ImportBatch` e `ImportError`.
- `GET /api/admin/imports` lista os lotes e `GET /api/admin/imports/:id` retorna o relatório.

## Contrato usado pelo frontend

| Fluxo da interface | Endpoint |
|---|---|
| Sessão atual | `GET /api/auth/session` |
| Campanhas do cliente | `GET /api/clients/:clientId/campaigns` |
| Lojas do cliente | `GET /api/clients/:clientId/stores` |
| Dashboard da campanha | `GET /api/campaigns/:campaignId/dashboard?storeId=all` |
| Resultados com filtros | `GET /api/campaigns/:campaignId/leads` |
| Exportação | `GET /api/campaigns/:campaignId/leads.csv` |
| Detalhe do lead | `GET /api/leads/:leadId` |
| Próximo lead do SDR | `GET /api/sdr/queue/next?campaignId=FEIRAO-VW-AGO` |
| Resumo diário do SDR | `GET /api/sdr/:sdrId/summary` |
| Registrar desfecho | `POST /api/leads/:leadId/outcomes` |
| Dashboard interno | `GET /api/operations/dashboard` |
| Token Twilio Voice SDK | `POST /api/telephony/token` |
| Abrir registro de chamada | `POST /api/telephony/calls` |
| TwiML App webhook | `POST /api/telephony/voice` |

Filtros aceitos em `leads`: `page`, `pageSize`, `search`, `storeId`, `status`, `vehicle`, `seller` e `audit`.

### Registrar um resultado

```json
{
  "result": "scheduled",
  "durationSec": 98,
  "notes": "Visita confirmada",
  "appointment": {
    "date": "2026-08-11T15:00:00-03:00",
    "period": "Tarde",
    "seller": "Carlos Mendes"
  }
}
```

Resultados possíveis: `scheduled`, `qualified`, `callback`, `no_answer`, `no_interest` e `invalid`. Para `qualified`, envie `qualification.type`; para `callback`, envie `callback.scheduledAt`.

O SDR é identificado exclusivamente pela sessão autenticada; valores de `sdrId` enviados pelo navegador são ignorados.

## Twilio

Configure o **Voice Request URL** do TwiML App (`TWILIO_TWIML_APP_SID`) para chamar:

```text
POST {PUBLIC_BASE_URL}/api/telephony/voice
```

O `PUBLIC_BASE_URL` precisa ser HTTPS e acessível pela Twilio. Para desenvolvimento local, exponha a porta `3333` com um túnel HTTPS e use a URL gerada tanto no `.env` quanto no TwiML App. Reinicie o backend depois de alterar o `.env`.

### Túnel local com ngrok (Windows)

Na primeira utilização, copie o authtoken exibido no painel da sua conta ngrok e configure-o no seu próprio terminal. Não salve esse token no projeto:

```powershell
ngrok config add-authtoken SEU_AUTHTOKEN
```

Com o backend executando na porta `3333`, abra outro terminal e rode:

```powershell
cd backend
npm run tunnel
```

Copie a URL HTTPS indicada em `Forwarding`, por exemplo `https://exemplo.ngrok-free.app`, e ajuste:

```env
PUBLIC_BASE_URL=https://exemplo.ngrok-free.app
```

No TwiML App da Twilio, configure o método `POST` e a Voice Request URL completa:

```text
https://exemplo.ngrok-free.app/api/telephony/voice
```

Mantenha o processo do ngrok aberto durante o teste. Em contas gratuitas, a URL pode mudar quando o túnel for reiniciado; quando isso ocorrer, atualize o `.env`, reinicie o backend e altere também a Voice Request URL do TwiML App.

No navegador, a tela Operação SDR executa automaticamente este fluxo:

1. solicite um token em `/api/telephony/token`;
2. crie o registro em `/api/telephony/calls`;
3. chame `device.connect({ params: { To: phoneE164, CallId: id } })`.

Os eventos do SDK atualizam a tela em tempo real e os webhooks atualizam SID, duração e URL da gravação. O navegador precisa estar em `localhost` ou HTTPS e o usuário deve permitir o acesso ao microfone.

Checklist da conta Twilio:

- `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` e `TWILIO_API_SECRET` pertencem à mesma conta;
- `TWILIO_API_KEY` é do tipo **Standard**; Restricted API Keys não podem criar Access Tokens para SDKs client-side;
- `TWILIO_TWIML_APP_SID` aponta para o TwiML App configurado com a URL acima;
- `TWILIO_PHONE_NUMBER` está em E.164 e é um número com Voice comprado na conta Twilio ou um Outgoing Caller ID já verificado;
- em contas trial, o destino da chamada precisa estar verificado;
- o país de destino precisa estar liberado nas permissões geográficas de Voice.

## Observação sobre os mocks

O seed replica as entidades e os totais do protótipo comercial. Os componentes do frontend ainda importam `mockData.ts` e `clientPortalData.ts`; a API já retorna os campos equivalentes para que essa troca possa ser feita tela a tela.
