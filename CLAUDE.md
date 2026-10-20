# CLAUDE.md — opencorp-claude

> **Leia primeiro o `LEIAME.md`**: o que o dono quer, decisões tomadas e registro de pedidos. Atualize-o a cada pedido novo.

## O que é este projeto

Fork de `opencorp` (orquestrador TypeScript de empresas autônomas com agentes de IA).
Objetivo: usar o **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) como motor base,
no lugar do spawn de CLI (`claude -p`) usado hoje pelo `ClaudeCodeDriver`.

Origem: clone local de `/home/j/Documentos/GitHub/opencorp` (branch `main`, commit `7166e61`).
Publicado (público) em https://github.com/MrJc01/crom-opencorp-claude como repositório TEMPORÁRIO; o original é https://github.com/crom-org/opencorp. Remote `origin`. Não faça `git push` sem o usuário pedir. Commits deste repo usam o e-mail noreply do GitHub (config local), nunca o Gmail pessoal.

## Estado atual

- Motor `claude-sdk` em uso por agentes, fluxos e Secretário dos workspaces `yt-factory-01` e `fundao`:
  `adapters/claude-sdk-adapter.ts` (conversa com aprovações), `drivers/claude-sdk-driver.ts` (execução de agente em sandbox
  bwrap) e `runners/claude-sdk-cli.ts` (`query()` do SDK em processo filho).
- O runner passa ao SDK `settingSources: ["project"]` e `skills: "all"`: carrega `CLAUDE.md` e `.claude/skills` do
  workspace e nada de `~/.claude` do dono. O corpo do agente (`.opencorp/agents/<id>.md` + skills declaradas, montado em
  `.opencorp/opencode/agent/<id>.md`) vai como `systemPrompt.append` via `--agente`. Antes disso os agentes recebiam só a ordem.
- `FlowStore.executar` tem trava por flow (`.opencorp/locks/executando-<flow>.json`): o mesmo flow não roda duas vezes
  ao mesmo tempo (o scheduler dispara ticks sobrepostos a cada 30 s).
- `pathComCliLocal()` (`utils/paths.ts`) põe `bin/path` (oc/opencorp deste fork) na frente do PATH de agentes,
  Secretário e scripts de flow. O `oc` global do PC aponta para o opencorp ORIGINAL.
- Serviço systemd do usuário `opencorp-daemon.service` aponta para ESTE fork (`daemon install --com-serve --host 127.0.0.1`,
  `Restart=always`, Linger ativo): sobe no boot sem login. A versão anterior, que apontava para o opencorp original,
  está no scratchpad da sessão de 2026-10-15. Depois de `npm run build`, reinicie com `systemctl --user restart opencorp-daemon`.
- Conta do Claude só para o OpenCorp: o serviço define `OPENCORP_CLAUDE_CONFIG_DIR=/home/j/.opencorp/claude-conta`. Depois de
  `CLAUDE_CONFIG_DIR=/home/j/.opencorp/claude-conta claude` + `/login`, agentes e Secretário passam a usar essa conta
  (`claudeConfigDirOpencorp()` em engines/drivers/claude-config-dir.ts; o sandbox monta essa pasta). Sem login lá, usa o ~/.claude padrão.
- `npm run build`, `npx tsc --noEmit -p .` e `npx vitest run` passam (166 arquivos, 1606 testes em 2026-10-20).
- Secretário web: histórico por log JSONL de eventos (`engines/event-log.ts`), runtime do Assistant UI alimentado pelo
  servidor, hook único de abas (`features/chat/hooks/useAbasSecretario.ts`). Núcleo agnóstico: timeouts/regras vêm do
  manifest do motor; `GET /api/motores` expõe o manifest; adaptador `openheinerss` registrado (opcional). Packs de domínio
  (ex.: YouTube Shorts) são dados, não código do núcleo. Ver `docs/CHECKLIST.md` e `.claude/notes/`.

## Onde o encaixe acontece

- `src/core/engines/ports.ts` — contrato `EngineAdapter` (`installer`, `authenticator`, `runner`, `conversationRuntime?`, `modelCatalog?`).
- `src/core/engines/events.ts` — `AgentEvent` canônico (`run.started`, `message.delta`, `tool.requested`, `tool.completed`, `approval.requested`, `usage.updated`, `run.completed`, `run.failed`).
- `src/core/engines/registry.ts` — `EngineRegistry` registra adaptadores com `registerAdapter`.
- `src/core/engines/drivers/claude-code-driver.ts` — instalação e auth reaproveitadas pelo claude-sdk; o `claude -p` dele não é usado pelos agentes.
- `src/core/engines/adapter-compat.ts` — `LegacyDriverAdapter`, que monta um `EngineAdapter` a partir de um driver.


## Notas do SDK (docs oficiais)

- Instalação: `npm install @anthropic-ai/claude-agent-sdk`.
- Entrada: `query({ prompt, options })`, que retorna um async generator de mensagens (`system`, `assistant`, `user`, `stream_event`, `result`).
- Opções úteis: `cwd`, `model`, `permissionMode`, `allowedTools`, `canUseTool`, `abortController`, `resume`, `maxTurns`, `env`, `settingSources`.
- Auth: API key (`ANTHROPIC_API_KEY`) ou login do Claude Code. Para produto distribuído a terceiros, a documentação diz que **não** é permitido oferecer login claude.ai ou rate limits próprios; usar API key.
- **Decisão:** o projeto é privado, de uso só do dono. Auth pelo login local do claude.ai (plano Pro), sem `ANTHROPIC_API_KEY` exportada no shell. Se algum dia for distribuído a outras pessoas, trocar para API key (cobrança por token).

## Vídeos (Remotion)

- Shorts dos dois canais são renderizados por `/home/j/.opencorp/remotion-shorts` (Remotion 4.0.530, fora deste repo).
  Composição em `src/Short.tsx`, marcas em `src/marcas.ts`, ponte `renderizar.mjs` importada por
  `workspaces/{yt-factory-01,fundao}/scripts/produzir_video.mjs`. Backups das versões antigas: scratchpad da sessão de 2026-10-15.
- Nó `script` de fluxo tem teto de 2 h (`flow-store.ts`); antes era 5 min e o render não cabia. Cada nó define `timeout_ms`.
- Scripts dos workspaces: `OPENCORP_WORKSPACE` é o ID no CLI; para caminho use `OPENCORP_WORKSPACE_DIR`.

## Esteira de Shorts dos workspaces (fora deste repo, em ~/.opencorp/workspaces/<ws>)

- Fluxo `yt-producao-15min`: estado → roteiro (@roteirista-video) → @checador-fatos → coleta de fotos + @curador-visual
  (olha as imagens) → `produzir_video.mjs` (Remotion) → @revisor-video (olha os quadros). Publicador só sobe `revisao.json`
  aprovado. Regra única em `scripts/esteira.mjs`; `node scripts/estado_pauta.mjs --resumo` mostra o estado.
- Skills em `<ws>/.opencorp/skills/` (checagem-de-fatos, curadoria-de-imagens, revisao-de-video, roteiro-de-short,
  operar-canal); `<ws>/.claude/skills` é link para lá. Cada workspace tem `CLAUDE.md` com linha editorial e mapa.
- Cópias obsoletas (pastas aninhadas criadas pelo bug do OPENCORP_WORKSPACE) estão em `~/.opencorp/arquivo-obsoleto-2026-10-15/`.
- Boletim longo do yt-factory-01 usa a mesma esteira (id `boletim-AAAA-MM-DD`, `scripts/estado_boletim.mjs`,
  composição Remotion "Boletim" em `remotion-shorts/src/Boletim.tsx`). Ciclo autônomo agora só faz saúde + relatório de qualidade.

## Validação

```bash
npx tsc --noEmit -p .
npx vitest run
npm run build
```

Suíte E2E (Playwright): 339–342 de 356 em 3 rodadas de 2026-10-20; falhas restantes são de carga da máquina e variam a cada rodada (ver `docs/CHECKLIST.md`). Rode com o PC ocioso.

## Pendências conhecidas

- `tests/runs-robustos.test.ts`: a falha sob carga era corrida do próprio teste (corrigida em 2026-10-20, 15/15).
- E2E (Playwright) roda isolado: `HOME=/tmp/e2e-home PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright test ...` (porta 4399, nunca o daemon da 4100). Não use `pkill -f` com texto do próprio comando. Um servidor E2E órfão chegou a 100% de CPU sem causa conhecida: matar a porta 4399 antes de rodar de novo.
- Testes que dependem de `dist/` e `web-dist/` exigem `npm run build` antes (já feito nesta cópia).

## Regras de trabalho

- **O PC do dono já travou duas vezes por falta de memória** (14 GB de RAM, 2 GB de swap, canais renderizando vídeo ao mesmo
  tempo; o log do boot mostrou "Under memory pressure" antes da queda). Por isso: TODA tarefa pesada (tsc, vitest, playwright,
  build) roda por `scripts/rodar-pesado.sh <comando>` (uma por vez, limite de memória, prioridade mínima). NUNCA rode carga
  artificial de CPU/memória (queimadores) e nunca duas suítes ao mesmo tempo, nem em sessões paralelas.

- Commits pequenos, em português, só quando o usuário pedir.
- Não desativar, pular ou marcar teste como flake para deixar verde; descobrir a causa.
- Não tocar no repositório original `/home/j/Documentos/GitHub/opencorp`.

## Orquestração de modelos

Skill `.claude/skills/orquestra-sonnet-opus-haiku`: Sonnet orquestra, Opus só consulta (`consultor`), Haiku executa
(`Explore`, `operario`) em `.claude/agents/`. Leia `.claude/notes/estado.md` e `decisoes.md` no início e atualize ao terminar.
Não defina `CLAUDE_CODE_SUBAGENT_MODEL` (sobrescreve o modelo dos agentes).
