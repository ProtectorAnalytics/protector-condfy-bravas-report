# Relatório Diário Condfy + Bravas

Pipeline automatizado que extrai cadastros do **Condfy** cruzando com 1 ou mais controladores **Bravas PRD0028**, gera um XLSX consolidado com 1 linha por (pessoa × local liberado) e envia diariamente por e-mail.

## Como funciona

1. **`extract.mjs`** — autentica em Condfy (login + refresh JWT) e nos controladores Bravas (UI PHP + API REST), e coleta:
   - Lista de credenciais da licença Condfy
   - Lista de usuários de cada controlador Bravas
   - Grupos de acesso e seus respectivos accesses (locais)
   - Cadastros detalhados de moradores, prestadores, visitantes e proprietários
2. **Cruza por nome** (`equipmentUserId` ↔ `bravas.user.name`) e une os locais liberados de todos os controladores onde a pessoa aparece (com dedup).
3. Gera XLSX com 12 colunas:
   - APT, NOME, TIPO, DATA EXPIRA, LOCAL LIBERADO, FACIAL S/N, RELAÇÃO RESPONSÁVEL, TELEFONE, NOTIFICAR ACESSO, MAIOR DATA DE LIBERAÇÃO, FABRICANTE, TIPO DISPOSITIVO
4. **`send.mjs`** — envia o XLSX mais recente via Resend.
5. **`daily.mjs`** — orquestra `extract + send` e notifica falha por e-mail.
6. **`.github/workflows/daily.yml`** — agenda execução diária às 7h BRT (10h UTC) via GitHub Actions.

## Rodar localmente

```bash
cp .env.example .env
# preencher .env
npm install
node --env-file=.env daily.mjs
```

## Configurar GitHub Actions

Adicionar os seguintes **Secrets** em `Settings → Secrets and variables → Actions`:

| Secret | Descrição |
|---|---|
| `CONDFY_EMAIL` | login Condfy |
| `CONDFY_PASSWORD` | senha Condfy |
| `CONDFY_LICENSE_ID` | ID numérico da licença Condfy |
| `BRAVAS_CONTROLLERS` | array JSON com cada controlador Bravas (`nome`, `host`, `uiPort`, `apiPort`) |
| `BRAVAS_USER` | usuário admin dos controladores Bravas |
| `BRAVAS_PASSWORD` | senha admin dos controladores Bravas |
| `RESEND_API_KEY` | API key Resend |
| `REPORT_FROM` | remetente (`Nome <email@dominio.com>`) — domínio precisa estar verificado no Resend |
| `REPORT_RECIPIENTS` | lista de e-mails separada por vírgula |
| `REPORT_CLIENT_NAME` | nome do condomínio (aparece no assunto e corpo do e-mail) |

A primeira execução pode ser disparada manualmente em `Actions → Relatório Diário Condfy + Bravas → Run workflow`.

## Limitações conhecidas

- **WAF do Condfy**: a interface JWT é limitada por TLS fingerprint. Em caso de bloqueio (HTTP 403 persistente), aguardar ~15 min ou reduzir frequência. Solução definitiva: migrar para a **API CPM** oficial (em processo de solicitação à Condfy).
- **Senha admin Bravas**: hoje o pipeline depende de credenciais admin do controlador. Quando a API CPM estiver disponível, a leitura de grupos pode ser feita diretamente pelo Condfy (`/bravasConfigurations/{id}/groups`), removendo essa dependência.
