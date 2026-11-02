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

### Frontend e backend em domínios diferentes

Quando o frontend está na Vercel e a API no Render, configure no serviço do
backend as origens exatas permitidas. Mais de uma origem pode ser informada,
separada por vírgula:

```env
FRONTEND_URL=https://crmontarget-git-main-aikids-projects.vercel.app,https://seu-dominio-de-producao.com.br
SESSION_COOKIE_SAME_SITE=none
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_PARTITIONED=true
```

`SameSite=None`, `Secure=true` e `Partitioned=true` são necessários para o
navegador enviar o cookie de sessão entre os domínios `vercel.app` e
`onrender.com`, inclusive em contextos que bloqueiam cookies de terceiros.
Não use `*` como origem porque a API recebe cookies com `credentials: include`.

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

Somente Gestores podem importar. Há duas origens disponíveis:

- `POST /api/admin/imports`: recebe `multipart/form-data` com `clientId`, `storeId`, `campaignId` e o arquivo `file`.
- `POST /api/admin/imports/google-sheets`: recebe JSON com `clientId`, `storeId`, `campaignId`, `spreadsheetUrl` e, opcionalmente, `sheetName`.

Todas as origens usam as mesmas colunas fixas:

| Coluna | Regra |
|---|---|
| `nome` | Obrigatória |
| `telefone` | Obrigatória; normalizada para E.164 |
| `veículo` | Obrigatória |
| `origem` | Obrigatória |
| `motivo` | Opcional |

- Limite de 10 MB e 10.000 linhas por lote.
- Telefones repetidos são aceitos e geram leads distintos.
- Linhas válidas são importadas mesmo quando outras linhas possuem erros.
- Cada lote mantém totais e erros por linha em `ImportBatch` e `ImportError`.
- `GET /api/admin/imports` lista os lotes e `GET /api/admin/imports/:id` retorna o relatório.

### Conta de serviço do Google Sheets

1. Ative a Google Sheets API no projeto do Google Cloud e crie uma conta de serviço com chave JSON.
2. Configure o JSON completo na variável `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` do backend.
3. Compartilhe a planilha como **Leitora** com o `client_email` da conta de serviço.
4. `GET /api/admin/imports/google-sheets/config` informa ao frontend se a integração está pronta e qual e-mail deve receber o compartilhamento, sem expor a chave privada.

Quando nenhuma aba é informada, o backend usa o `gid` do link; se ele não existir, utiliza a primeira aba visível. O Google Sheets segue o mesmo modelo de colunas, limite de 10.000 leads, validações e importação parcial dos arquivos.

## Contrato usado pelo frontend

### Fila SDR, tentativas e retornos

A fila usa PostgreSQL com `FOR UPDATE SKIP LOCKED`. Cada lead fica reservado por 15 minutos para um único SDR, e o frontend renova essa reserva durante o atendimento. Uma tentativa só pode ser registrada pelo SDR proprietário da reserva.

| Ação | Endpoint |
|---|---|
| Campanhas ativas | `GET /api/sdr/campaigns` |
| Reservar próximo lead FIFO | `POST /api/sdr/queue/claim` |
| Renovar reserva | `POST /api/sdr/queue/renew` |
| Liberar reserva | `POST /api/sdr/queue/release` |
| Retornos do dia | `GET /api/sdr/callbacks/today` |
| Reservar um retorno vencido | `POST /api/sdr/callbacks/:leadId/claim` |
| Registrar tentativa e resultado | `POST /api/leads/:leadId/outcomes` |

Retornos são atribuídos ao SDR que os registrou e ficam fora da fila automática. O limite é de três tentativas por lead. `NO_ANSWER` devolve o lead à fila até a terceira tentativa; ao atingir o limite, o status passa a `EXHAUSTED`.

### Dashboard e consulta operacional

Somente Gestores podem acessar os endpoints operacionais globais. Os indicadores são calculados a partir das tentativas persistidas, sem depender do provedor de telefonia ou dos dados demonstrativos do frontend.

| Ação | Endpoint |
|---|---|
| Dashboard básico | `GET /api/operations/dashboard` |
| Consulta paginada de leads | `GET /api/operations/leads` |
| Histórico completo de um lead | `GET /api/leads/:leadId` |

O dashboard aceita `dateFrom`, `dateTo`, `clientId`, `storeId`, `campaignId` e `sdrId`. O período máximo é de 92 dias.

A consulta de leads aceita `search`, `clientId`, `storeId`, `campaignId`, `status`, `sdrId`, `page` e `pageSize`. A busca considera nome, telefone, veículo e origem; `pageSize` é limitado a 50 registros.

| Fluxo da interface | Endpoint |
|---|---|
| Sessão atual | `GET /api/auth/session` |
| Campanhas do cliente | `GET /api/clients/:clientId/campaigns` |
| Lojas do cliente | `GET /api/clients/:clientId/stores` |
| Dashboard da campanha | `GET /api/campaigns/:campaignId/dashboard?storeId=all` |
| Resultados com filtros | `GET /api/campaigns/:campaignId/leads` |
| Exportação | `GET /api/campaigns/:campaignId/leads.csv` |
| Detalhe do lead | `GET /api/leads/:leadId` |
| Próximo lead do SDR | `POST /api/sdr/queue/claim` |
| Resumo diário do SDR | `GET /api/sdr/:sdrId/summary` |
| Registrar desfecho | `POST /api/leads/:leadId/outcomes` |
| Dashboard interno | `GET /api/operations/dashboard` |
| Iniciar chamada 3CX | `POST /api/telephony/calls` |
| Consultar estado da chamada | `GET /api/telephony/calls/:callId/status` |
| Encerrar chamada | `POST /api/telephony/calls/:callId/hangup` |
| Áudio bidirecional PCM | `WS /api/telephony/calls/:callId/media` |
| Criar intenção Asterisk | `POST /api/telephony/asterisk/calls` |
| Consultar chamada Asterisk | `GET /api/telephony/asterisk/calls/:callId` |
| Eventos da chamada Asterisk | `GET /api/telephony/asterisk/calls/:callId/events` |
| Encerrar chamada Asterisk | `POST /api/telephony/asterisk/calls/:callId/hangup` |

Filtros aceitos em `leads`: `page`, `pageSize`, `search`, `storeId`, `status`, `vehicle`, `seller` e `audit`.

### Registrar um resultado

```json
{
  "outcome": "CALLBACK",
  "notes": "Cliente pediu retorno no fim da tarde",
  "callback": {
    "scheduledAt": "2026-10-04T18:00:00-03:00"
  }
}
```

Resultados possíveis: `NO_ANSWER`, `INVALID_NUMBER`, `REFUSED`, `CONTACTED`, `QUALIFIED`, `NOT_QUALIFIED` e `CALLBACK`. Para `CALLBACK`, envie `callback.scheduledAt` com uma data futura.

O SDR é identificado exclusivamente pela sessão autenticada; valores de `sdrId` enviados pelo navegador são ignorados.

## Fundação Asterisk + OverTele

A migração da telefonia para Asterisk/ARI é incremental. A primeira etapa adiciona ao banco:

- estado técnico persistente da chamada;
- intenção idempotente por SDR;
- eventos ordenados por chamada;
- identificadores ARI de canais e bridge;
- causas SIP/Q.850;
- metadados de gravação sem armazenar WAV no PostgreSQL;
- índice parcial que impede duas chamadas Asterisk ativas para o mesmo SDR.

A segunda etapa adiciona ao backend Node:

- cliente ARI REST com Basic Auth somente no servidor;
- WebSocket ARI com reconexão exponencial limitada;
- processamento sequencial dos eventos recebidos;
- deduplicação persistente por chamada;
- payload sanitizado, sem nome do canal ou telefone completo;
- estado técnico Asterisk no endpoint `GET /health`.

A terceira etapa implementa o motor de chamadas em Node:

- intenção persistida e idempotente antes de qualquer originação;
- correlação segura entre intenção e canal WebRTC, sem escolher arbitrariamente entre SDRs;
- originação `PJSIP/<destino>@overtele` feita exclusivamente pelo backend;
- estados `READY`, `DIALING`, `RINGING`, `CONNECTED`, terminais e `RECONCILING`;
- bridge `mixing,proxy_media` com os canais WebRTC e OverTele;
- gravação WAV nativa da bridge e metadados no PostgreSQL;
- encerramento idempotente, timeout de segurança e causas Q.850;
- reconciliação com canais e bridges ativos após reconexão do WebSocket ARI.

`POST /api/telephony/asterisk/calls` exige `Idempotency-Key` de 8 a 128 caracteres e devolve HTTP 202 para uma nova intenção. O destino vem do lead reservado no backend, nunca do navegador. Após a resposta, o frontend deve chamar a extensão SIP interna informada em `sipExtension`; essa parte será ligada à tela SDR na etapa seguinte.

A quarta etapa integra o SIP.js da tela SDR. As credenciais SIP continuam no backend e `GET /api/telephony/asterisk/session` entrega somente o ramal vinculado ao SDR autenticado, com resposta privada e sem cache. Em produção, cada SDR deve possuir um endpoint PJSIP exclusivo:

```env
ASTERISK_SIP_WSS_URL=wss://voz.seu-dominio.com/ws
ASTERISK_SIP_DOMAIN=voz.seu-dominio.com
ASTERISK_SIP_ACCOUNTS_JSON={"ana@empresa.com":{"extension":"201","password":"segredo-individual"},"diego@empresa.com":{"extension":"202","password":"outro-segredo"}}
```

O modo abaixo existe somente para validar a POC com o ramal 201 já instalado. Ele impede uso simultâneo correto e não deve ser habilitado em produção:

```env
ASTERISK_ALLOW_SHARED_SIP_ACCOUNT=true
ASTERISK_SIP_EXTENSION=201
ASTERISK_SIP_PASSWORD=segredo-do-ramal-201
```

O `/health` informa `telephony.asterisk.sip.configured`, a quantidade de contas provisionadas e se o modo compartilhado de POC está ativo, sem expor ramais ou senhas.

O consumidor permanece desativado enquanto `ASTERISK_ENABLED=false`. Para a primeira validação real, abra o túnel SSH, configure as credenciais somente em `backend/.env` e então ative a integração. Não copie as credenciais para o frontend nem para este README.

Durante o desenvolvimento local, o backend acessará a ARI privada da VM por túnel SSH:

```env
ASTERISK_ENABLED=false
ARI_HTTP_URL=http://127.0.0.1:18088
ARI_WS_URL=ws://127.0.0.1:18088
ARI_APP=crm_browser_poc
ARI_USER=preencher-no-env-privado
ARI_PASSWORD=preencher-no-env-privado
ASTERISK_SIP_WSS_URL=ws://127.0.0.1:18088/ws
ASTERISK_SIP_DOMAIN=34.95.194.220
ASTERISK_SIP_ACCOUNTS_JSON=
ASTERISK_ALLOW_SHARED_SIP_ACCOUNT=false
ASTERISK_SIP_EXTENSION=
ASTERISK_SIP_PASSWORD=
ASTERISK_INTERNAL_EXTENSION=902
ASTERISK_WEB_APP_ARG=web201
ASTERISK_WEB_CHANNEL_PREFIX=PJSIP/201-
OVERTELE_TRUNK_NAME=overtele
CALL_INTENT_TTL_SECONDS=30
MAX_CALL_SECONDS=7200
ARI_RECONNECT_MIN_MS=1000
ARI_RECONNECT_MAX_MS=30000
```

Quando backend e Asterisk estiverem na mesma VM, as URLs ARI devem usar `127.0.0.1:8088`. A ARI nunca deve ser publicada pelo proxy público. O frontend receberá apenas configuração SIP autorizada; usuário e senha ARI permanecem exclusivamente no backend.

O código 3CX abaixo permanece temporariamente operacional até o motor ARI em Node assumir as rotas. Depois da chamada Asterisk ponta a ponta, ele e o WebSocket PCM serão removidos.

## Telefonia 3CX + OverTele (legado temporário)

As credenciais OAuth pertencem somente ao backend:

```env
CX3_PBX_URL=https://8rtech.my3cx.com.br
CX3_CLIENT_ID=crmontarget
CX3_CLIENT_SECRET=seu-secret
CX3_APP_DN=crmontarget
```

O frontend nunca recebe o `CLIENT_SECRET` nem o token da PBX. Ao clicar em **Ligar com Onvox**, o fluxo é:

1. o navegador solicita acesso ao microfone;
2. `POST /api/telephony/calls` valida a sessão, a reserva do lead e normaliza o telefone para `DDD + número`;
3. o backend autentica em `/connect/token` e executa `POST /callcontrol/crmontarget/makecall`;
4. a interface consulta o estado até encontrar `Dialing` ou `Connected` em `/participants`;
5. quando conectada, abre um WebSocket autenticado com o backend;
6. o backend faz a ponte dos streams PCM 16-bit, 8 kHz, mono entre navegador e 3CX;
7. ao desligar, o backend envia a ação `drop` para o participante e persiste duração/encerramento.

O navegador precisa estar em `localhost` ou HTTPS e o SDR deve permitir o uso do microfone. Em produção, o proxy reverso deve aceitar upgrade de WebSocket no caminho `/api/telephony/calls/*/media`. Não é necessário configurar webhook ou expor o backend diretamente à PBX: todas as chamadas HTTP são iniciadas pelo backend.

Checklist 3CX:

- a integração `crmontarget` possui acesso à Call Control API;
- `CX3_CLIENT_ID` e `CX3_APP_DN` correspondem ao DN configurado;
- o secret está apenas em `backend/.env`;
- a licença 3CX permite Call Control;
- o tronco OverTele aceita o destino no formato `DDD + número`;
- o proxy e firewall permitem conexões HTTPS de saída para a PBX;
- o proxy do backend mantém WebSockets e streams de longa duração abertos.

## Observação sobre os mocks

O seed replica as entidades e os totais do protótipo comercial. A tela de Operação SDR já usa a API real; dashboard e parte do Portal do Cliente ainda usam dados demonstrativos e serão migrados nas etapas seguintes.
