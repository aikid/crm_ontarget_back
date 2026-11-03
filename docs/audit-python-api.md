# API de integração da auditoria Python

Esta API é máquina-a-máquina. Ela não utiliza cookies, CSRF ou uma conta humana do SysOn.

## Configuração

Gere um token aleatório com pelo menos 32 caracteres e configure o mesmo valor somente no backend Render e no serviço Python:

```env
AUDIT_INTEGRATION_TOKEN=token-aleatorio-longo-e-exclusivo
```

Envie o token em todas as chamadas:

```http
Authorization: Bearer <AUDIT_INTEGRATION_TOKEN>
```

Nunca coloque esse token no frontend, no repositório ou em parâmetros da URL.

## 1. Listar gravações pendentes

```http
GET /api/integrations/audit/recordings?limit=50&cursor=<cursor-opcional>
```

Retorna somente gravações `STORED_LOCAL`, não expiradas e que ainda não possuem auditoria. `limit` aceita de 1 a 100.

```json
{
  "data": [
    {
      "recordingId": "cmw...",
      "callId": "cmv...",
      "attemptId": "cmx...",
      "format": "wav",
      "availableAt": "2026-11-03T13:20:00.000Z",
      "expiresAt": "2027-01-02T13:20:00.000Z",
      "durationSec": 42,
      "downloadPath": "/api/telephony/asterisk/calls/cmv.../recording",
      "lead": {
        "id": "lead-id",
        "clientId": "cliente-id",
        "campaignId": "campanha-id",
        "storeId": "vendedor-id",
        "name": "Nome do cliente"
      },
      "attempt": {
        "id": "cmx...",
        "sequence": 1,
        "outcome": "DIRECTED",
        "notes": "Cliente direcionado",
        "startedAt": "2026-11-03T13:18:00.000Z",
        "finishedAt": "2026-11-03T13:21:00.000Z"
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "nextCursor": null
  }
}
```

Gravações históricas podem possuir `attemptId` e `attempt` nulos. As novas ligações ficam vinculadas à tentativa quando o SDR salva o resultado.

## 2. Baixar o áudio

Use o `downloadPath` retornado na listagem:

```http
GET /api/telephony/asterisk/calls/:callId/recording
Authorization: Bearer <AUDIT_INTEGRATION_TOKEN>
```

A resposta é o conteúdo binário WAV. Não é necessário acessar a VM, a ARI ou o Neon diretamente.

## 3. Registrar ou atualizar a auditoria

```http
PUT /api/integrations/audit/recordings/:recordingId/audit
Content-Type: application/json
Authorization: Bearer <AUDIT_INTEGRATION_TOKEN>
```

```json
{
  "classification": "confirmed",
  "confidence": 94,
  "evidence": "Cliente confirmou interesse no veículo.",
  "observations": "Encaminhar ao vendedor no período da tarde.",
  "modelVersion": "auditor-python-v1"
}
```

Regras:

- `classification`: obrigatório, até 80 caracteres;
- `confidence`: inteiro obrigatório entre 0 e 100;
- `evidence`: opcional, até 10.000 caracteres;
- `observations`: opcional, até 10.000 caracteres;
- `modelVersion`: obrigatório, até 120 caracteres.

O endpoint é idempotente por `recordingId`: a primeira chamada retorna `201`; repetições atualizam a mesma auditoria e retornam `200`. Nunca são criadas duas auditorias para a mesma gravação.

## Exemplo Python

```python
import os
import requests

BASE_URL = "https://crm-ontarget-back.onrender.com"
HEADERS = {"Authorization": f"Bearer {os.environ['SYSON_AUDIT_TOKEN']}"}

pending = requests.get(
    f"{BASE_URL}/api/integrations/audit/recordings",
    headers=HEADERS,
    timeout=30,
).json()["data"]

for item in pending:
    audio = requests.get(
        f"{BASE_URL}{item['downloadPath']}",
        headers=HEADERS,
        timeout=120,
    )
    audio.raise_for_status()

    result = {
        "classification": "confirmed",
        "confidence": 94,
        "evidence": "Cliente confirmou interesse.",
        "observations": "Sem divergências.",
        "modelVersion": "auditor-python-v1",
    }
    response = requests.put(
        f"{BASE_URL}/api/integrations/audit/recordings/{item['recordingId']}/audit",
        headers=HEADERS,
        json=result,
        timeout=30,
    )
    response.raise_for_status()
```

## Respostas de erro

- `400`: payload inválido;
- `401`: token ausente ou inválido;
- `404`: gravação ou chamada inexistente;
- `409`: gravação ainda não concluída;
- `410`: gravação expirada/removida;
- `503`: token técnico não configurado no backend.
