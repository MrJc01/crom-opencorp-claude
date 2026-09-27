# 08 — Referência CLI

Binário: `opencorp` (em `bin/opencorp.mjs`). Convenções: `--workspace <id>` sobrepõe o ativo; `--json` imprime saída machine-readable; `-y` pula confirmações.

## Geral

```bash
opencorp init [--dir .]        # prepara repo: estrutura, settings global, template default
opencorp doctor                # diagnóstico: node, motores configurados (instalados/autenticados), configs válidas, segredos fora dos ws
opencorp --version
opencorp <cmd> --help
```

## settings (painel de configurações)

```bash
opencorp settings                        # painel TUI interativo
opencorp settings list [--scope global|workspace]
opencorp settings get <chave>
opencorp settings set <chave> <valor> [--scope global|workspace]
opencorp settings edit [--scope ...]
opencorp settings path
opencorp settings reset <chave> [--scope ...]
```

## motores e migração (multimotores)

```bash
opencorp motores list [--json]      # motores, instalação, contas, padrão e cadeia de fallback
opencorp motores set <id>           # grava settings.run_engine.default (nunca runner.json)
opencorp motores test <id>          # saúde barata (sem inferência)

opencorp migrate-configs            # dry-run: lista arquivos, campos e transformações
opencorp migrate-configs --check    # exit 3 se houver migração pendente
opencorp migrate-configs --apply    # backup (SHA-256) → validação → escrita atômica
opencorp migrate-configs --rollback [backup-id]   # restaura byte a byte (padrão: último)
opencorp migrate-configs --list-backups [--json] [--workspace <id>]
```

Exit codes do `migrate-configs`: 0 ok · 1 erro · 2 resultado inválido (nada alterado) · 3 pendente (`--check`) · 4 rollback falhou.

API correspondente (Bearer token):

| Rota | Função |
|---|---|
| `POST /api/motores/:id/test` | saúde multinível; corpo `{nivel, modelo, confirmarCusto, maxTokens, timeoutMs}`; níveis ≥ `inference` exigem `confirmarCusto: true` |
| `POST /api/motores/:id/install` | instalação gerenciada explícita (artefato com SHA-256) |
| `GET /modelos/catalogo` | catálogo com proveniência, motores compatíveis e probes |
| `GET /api/config/migracao` | prévia da migração |
| `POST /api/config/migracao/aplicar` | aplica; exige `{ "confirmar": true }` |
| `POST /api/config/migracao/rollback` | restaura o último backup (ou `{ "backup": "<id>" }`) |
| `GET /secretario/status?workspace=<id>` | motor resolvido do Secretário, origem e preflight |

Probes reais (opt-in, consomem cota): `OPENCORP_REAL_PROBES=codex,copilot,mimo OPENCORP_PROBE_<MOTOR>_MODEL=<modelo> npm run test:real`.

## workspace

```bash
opencorp workspace create <id> [--template <tpl>]
opencorp workspace list
opencorp workspace show [id]
opencorp workspace delete <id>
opencorp use <id>                # workspace ativo
opencorp workspace current
```

## agent

```bash
opencorp agent create <id> [--from <agente>] [--model provider/model]
opencorp agent list [--categoria ceo|secretario|operario|custom]
opencorp agent show <id>
opencorp agent edit <id>
opencorp agent clone <origem> <destino>
opencorp agent run <id> "<ordem>" [--model m] [--session id] [--file f]
           [--gatilho <tipo>:<origem>]
# --gatilho declara quem ativa a execução no ledger unificado (corp.db `execucoes`):
#   manual|cron|evento|mencao|webhook|dependencia|padrao|turno  (ex.: --gatilho cron:sch-abc)
opencorp agent history <id>       # últimas execuções (registries/execucoes)
opencorp agent cost <id>          # gasto acumulado (registries/custos)
```

## task (kanban + chat por task)

```bash
opencorp task list [--coluna <c>] [--responsavel <a>] [--json]
opencorp task create --titulo "..." [--descricao ...] [--coluna backlog] [--prioridade baixa|media|alta] [--responsavel humano|agente:<id>] [--due AAAA-MM-DD]
opencorp task show <id> [--json]
opencorp task move <id> --coluna <coluna>        # coluna é FLAG obrigatória (não posicional)
opencorp task assign <id> <responsavel>
opencorp task label <id> [--add a,b] [--remove c]
opencorp task chat <id> [--msg "..." --autor humano|agente:<id> --tipo comentario|handoff|sistema|artefato|decisao]
opencorp task run <id> [--agent <id>] [--model provider/model]   # despacha o responsável agora
opencorp task status <id> [--limite N] [--json]
opencorp task columns
opencorp task delete <id>
# contrato do agente executando a task (ver mention-runner): postar resposta e concluir com
#   opencorp task chat <id> --msg "..." --autor agente:<eu> --tipo comentario
#   opencorp task move <id> --coluna feito
```

## schedule / scheduler (rotinas + pulso)

```bash
opencorp schedule list
opencorp schedule create --nome <nome> (--cron "0 9 * * *" | --intervalo-min 60 | --as <ISO>) --args "agent run <ag> \"<ordem>\"" [--workspace <id>] [--graca-min 5]
# ATENÇÃO: a ordem do agent run é POSICIONAL — não existe --ordem (jobs criados com --ordem morrem no parser sem rastro)
opencorp schedule show <id>
opencorp schedule pause <id> | opencorp schedule resume <id>
opencorp schedule run-now <id>                       # dispara agora, sem esperar o horário
opencorp schedule delete <id>
opencorp scheduler start | opencorp scheduler stop | opencorp scheduler status
opencorp settings set scheduler.timezone America/Bahia            # fuso global dos crons (IANA)
opencorp settings set scheduler.timezone America/Bahia --scope workspace   # override do workspace ativo
# API útil: GET /schedules/:id/runs (disparos do agendador), GET /tasks/:id/execucoes (execuções vinculadas)
# IMPORTANTE: `opencorp serve` sozinho NÃO faz tick — sem `opencorp daemon start`, proxima_exec congela no passado.
```

## session

```bash
opencorp session list [--agent <id>]
opencorp session log <id>
opencorp session kill <id>
```

## run (ordem rápida no ativo)

```bash
opencorp run "<ordem>" [--agent executor-padrao] [--gatilho <tipo>:<origem>]   # atalho de agent run
```

## flow (durável — retomada e migração)

```bash
opencorp flow run <id> [--entrada texto] [--model m]
opencorp flow status <id>                              # última execução, status por nó
opencorp flow resume <id> <execId> [--model m]         # retoma execução FALHA do último nó ok
# nós "ok" do run anterior não re-executam; o contexto final é preservado (mesmo exec)
opencorp flow migrate-teams                            # converte teams legados em fluxos (v0.6.0)
# cada teams/<id>.json vira flows/<id>.json (pipeline→nós agente em sequência; fanout/review/debate→nó correspondente)
# o team original é arquivado como <id>.json.migrado; POST /teams segue existindo (deprecado)
```

## registry (registros globais)

```bash
opencorp registry list [categoria]
opencorp registry create <cat>/<id> -d "<descrição>" [--perm-leitura x] [--perm-escrita y]
opencorp registry get <cat>/<id>
opencorp registry update <cat>/<id> [--conteudo s|--conteudo-arquivo f] [--descricao s]
opencorp registry log <cat>/<id> "<anotação>"      # só anexa no journal
opencorp registry perms <cat>/<id> [--leitura l] [--escrita w] [--meta m]
opencorp registry search "<termo>"
opencorp registry reindex                          # reconstrói SQLite a partir das pastas
```

## approvals (HITL)

```bash
opencorp approvals list
opencorp approvals approve <id>
opencorp approvals reject <id> --motivo "..."
```

## app (Mini-Apps declarativos)

```bash
oc app list                                               # lista os mini-apps do workspace
oc app novo <id> [--titulo "Nome"] [--descricao "Texto"]  # cria app com template index.html inicial
oc app open <id>                                          # abre o app no navegador padrão
oc app delete <id>                                        # exclui mini-app e arquivos
```

## secret (Segredos & Credenciais)

```bash
oc secret set <chave> <valor> [--scope global|workspace]  # grava credencial protegida
oc secret get <chave>                                     # lê o valor do segredo (somente local)
oc secret list [--scope global|workspace]                 # lista chaves e origens (valores nunca expostos)
oc secret delete <chave> [--scope global|workspace]       # remove um segredo
```

## budget

```bash
opencorp budget status [--workspace id]
opencorp budget set --daily-usd 5 --per-agent-usd 1
```

## template & subcorp

```bash
opencorp template list
opencorp template create <id>
opencorp template export <ws> [-o arquivo.corp]
opencorp template import <pasta|arquivo.corp|url> [--as id]
opencorp subcorp add <path|template> --as <id> [--perm read|ask|write]
opencorp subcorp list
opencorp subcorp remove <id>
```

## test (teste cego)

```bash
opencorp test blind <etapa> [--model provider/model] [--timeout min] [--list]
# <etapa>: número ("01") ou fragmento ("workspaces") de docs/tests/ETAPA-XX-*.md; "all" roda todas em sequência
# rotação automática de modelos free em rate limit/timeout (settings tests.rotation)
# relatório e logs em .opencorp/reports/testes/ · exit 0 = PASS, 1 = FAIL
opencorp test blind all          # regressão completa + relatório consolidado
```

## cloud (opcional — ETAPA 8)

```bash
opencorp cloud configure        # wizard de perfis (backup-local | backup-nuvem | mirror-remoto)
opencorp cloud backup           # executa backup agora
opencorp cloud sync [--dry-run]
opencorp cloud status           # último backup, diffs pendentes, saúde dos remotos
```

## Exit codes

| Código | Significado |
|---|---|
| 0 | sucesso |
| 1 | erro genérico do comando |
| 2 | config/schema inválido |
| 3 | bloqueio do SecurityGuard |
| 4 | orçamento esgotado |
| 5 | HITL pendente/negado |
