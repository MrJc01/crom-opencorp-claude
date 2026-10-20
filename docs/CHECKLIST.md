# Checklist de pedidos — opencorp-claude

## 📥 Pedidos de 2026-10-20

**Feito**
- [x] Instalar a skill `orquestra-sonnet-opus-haiku`, agentes `Explore`/`operario`/`consultor` e notas — `.claude/` e seção nova no `CLAUDE.md`
- [x] Diagnóstico do Secretário web (front, backend, agnosticismo) — `.claude/notes/estado.md`
- [x] README do workspace fundao — `~/.opencorp/workspaces/fundao/README.md`
- [x] README do workspace yt-factory-01 — `~/.opencorp/workspaces/yt-factory-01/README.md`
- [x] Criado este checklist (docs/CHECKLIST.md)

**A fazer — pedidos novos (ordem de prioridade)**
Passos de A+B (ordem do Opus): [x] 1 evento `approval.resolved` (`events.ts`)  [x] 2 gravar JSONL em `stream.ts` (`engines/event-log.ts`, 5 testes)  [x] 3 GET de histórico (`sessions.ts`, lê o log; cai no opencode se não houver log)  [x] 4 ExternalStoreRuntime (`runtime/*`: store local + SSE + recarga do servidor; card grava decisão no store; `criarSecretarioModelAdapter` removido)  [x] 5 card lê status do histórico (`EngineApprovalCard`)  [x] 6 unificar abas (`hooks/useAbasSecretario.ts`)
Evidência: tsc limpo, `npx vitest run` 1550 passando. NÃO testado no navegador ainda; daemon não reiniciado. Desvio do parecer: aprovação não é espelhada no `approvals-store` (schema diferente, do guard); o log é a fonte.

1. [x] **Frente A — dados:** endpoint de histórico do claude-sdk com IDs estáveis de mensagem; aprovações (pendentes e resolvidas) persistidas no `approvals-store`; reabrir o chat mostra histórico e o status real das aprovações (aprovada não pede aprovar de novo)
2. [x] **Frente B — Secretário no Assistant UI:** trocar `useLocalRuntime` por runtime alimentado pelo servidor; uma só fonte de abas (hook único para `SecretarioView` e `SecretarioDock`); um só caminho de aprovação; abas com sentido (menos confusão); código organizado e fácil de manter
3. [~] **Frente C (núcleo feito 2026-10-20: session-manager/execution-driver/paths/catalog/model-resolver/helpers consultam driver/manifest; AgentRunInput/AgentEvent/manifest ampliados; fake adapter em tests/engine-fake-adapter.test.ts; esqueleto openheinerss em ports.ts. Falta: front/constantes (MOTOR-UI), credentials-store ainda tem tabelas por motor, inferirHarness tem prefixos fixos) — agnóstico de motor:** tirar o que é Claude do núcleo (`session-manager`, `execution-driver`, `paths`, `credentials-store`, `catalog`, `model-resolver`, `secretario/helpers`, `context-builder`, front); timeouts/flags no manifest do motor; ampliar `AgentEvent`/`EngineAdapter` (permissões, artefato, sessão/resume); preparar adaptador para o openheinerss (Go, JSON-RPC)
4. [x] Agnóstico de domínio: packs YouTube Shorts (`packs-store.ts`) e `AtivosView.tsx` fora do núcleo (OpenCorp serve para qualquer empresa, não só fundão/bitcoin)
5. [x] Consulta ao Opus sobre o desenho de A+B — parecer em `.claude/notes/decisoes.md` (log JSONL + ExternalStoreRuntime)
6. [ ] Resumo/atualização ao dono a cada etapa concluída

**Teste real no navegador (2026-10-20, ws fundao, porta 4100) — A+B**
- [x] Histórico volta ao sair e voltar para o chat (log JSONL em `~/.opencorp/secretario-log/<ws>/<sessao>.jsonl`; o caminho foi corrigido: estava fora de `.opencorp`)
- [x] Abas: uma por conversa, `+` cria nova, aba vira a sessão real após a primeira mensagem
- [x] Cartão de aprovação reaparece com botões ao recarregar; fica "Expirada" quando o turno já acabou
- [x] Aprovação/ferramenta aparecem AO VIVO (corrigido pela frente-runtime: havia remount no meio do turno; reconfirmado no navegador)
- [x] BUG corrigido: recarregar/sair da tela abortava o turno com aprovação pendente (`stream.ts`: com aprovação pendente o turno segue vivo, prazo 10 min). Reconfirmado no navegador: sair para Tarefas e voltar mantém o botão Aprovar; aprovar depois executa o comando
- [x] Rótulo "Falha"/"modelo não retornou texto" sumiram (eram efeito do abort); agora "Executando" → "Aguardando sua aprovação" → "Executado"
- [x] BUG corrigido: cartão mostrava "Expirada" mesmo aprovado, porque `system.ts` também atende `/secretario/hitl/...` e `hitl.ts` nunca rodava; o registro da decisão foi para `responderAprovacaoDoRuntime` (ponto único). Reconfirmado: cartão "Aprovado." após recarregar
- [x] Limpeza: `hitl.ts` removido (rota morta duplicada de `system.ts`, que roda antes); 1568 testes passando
- [x] Dock (Ctrl+J) testado no navegador: abre na mesma conversa da tela cheia, com a aprovação já "Aprovado."
- [x] Conversas antigas (sem log) agora mostram histórico: contrato novo `ConversationRuntime.history?` + `claude-sdk-history.ts` (lê a transcrição do SDK e tira o contexto do workspace colado); testado por curl numa sessão de 10-16

**Rodada 2 (2026-10-20, tarde)**
- [x] MOTOR-UI: front sem motor/modelo fixo; `GET /api/motores` devolve manifest + perfil de login (visto só em tsc/vitest, falta olhar no navegador)
- [x] MOTOR-CRED: credenciais por manifest (`registerEngineCredentialPolicy` ligado ao `EngineRegistry.registerAdapter`); claude-sdk SEM `credentialEnvVars` de propósito (usa login do plano, nunca ANTHROPIC_API_KEY)
- [x] OPENHEINERSS: adaptador JSON-RPC registrado como motor opcional (binário ausente = indisponível); testes com servidor falso
- [x] QUALIDADE: E2E isolado rodou (356: 344 ok, 11 ignorados, 1 falha de src); `runs-robustos` era corrida do teste (corrigida, 15/15)
- [x] Bug de src: `POST /flows/:id/run` devolvia exec_id de execução que nunca existia quando o flow já rodava → agora 409 (`FlowStore.emExecucao`; teste novo)
- [x] `credentials-bridge`: "claude login" → "claude auth login"
- [x] Bug de src (QUALIDADE): tool UIs inline em `SecretarioChat.tsx` remontavam o PerguntaCard — corrigido pela frente-runtime; `secretario-custom-persistence` passou 2/2 rodadas (E2E de chat: 39 ok/0 falhas em home limpo)
- [x] BUG INTERMITENTE (era 25%, 2 de 8): `ia-perguntas-opcoes.spec.ts:69` — a frente-runtime corrigiu 2 causas lidas no código (onNew descartava o clique; corrida na hidratação); não reproduzia antes do fix. Depois: 20/20 (runtime) e 16/16 (minha verificação) no build novo. Evidência forte, causa não vista em traço
- [x] `claude-sdk` aparecia "Autenticar" na tela de motores (faltava regra em `checkEngineAuthStatus`): agora usa o login do plano, ignorando ANTHROPIC_API_KEY; `openheinerss` listado (11 motores) e tratado como ponte local sem credencial própria
- [ ] Sem explicação: um servidor E2E órfão (porta 4399, home `/tmp/opencorp-e2e` com dados de rodadas antigas) ficou a 110% de CPU e derrubou 12 testes em cascata; um servidor novo não reproduz (nem em repouso, nem após 2 rodadas seguidas, nem com stdout fechado). Evidência perdida ao apagar o home. Vigiar
- [x] E2E do cartão Aprovar do Secretário: `tests/e2e/secretario-aprovacao.spec.ts` (aprovar e rejeitar; ao vivo, sair e voltar, F5), com motor conversacional falso = binário `openheinerss` falso (`tests/e2e/fixtures/bin/openheinerss`, env `OPENHEINERSS_BIN`). 16/16 em 8 repetições no build real
- [x] Webhook `POST /flows/:id/webhook` com o flow já rodando: responde 202 `status:"ignorado_em_execucao"`, `exec_id:null` (webhook tem que ser 2xx; 409 quebrava o contrato e o teste de rate limit); teste novo

**Fechamento da rodada 2 (2026-10-20, 15h)**
- [x] Servidor HTTP: `keepAliveTimeout=65s` (padrão do Node era 5 s e gerava `ECONNRESET` em clientes que reaproveitam a conexão: derrubava `agenda-fluxos` e `tasks` no E2E). Teste: `tests/server-keepalive.test.ts`. Depois do ajuste: 0 `ECONNRESET` na suíte inteira
- [x] E2E completo no build final, 3 rodadas: 339–342 passados / 11 ignorados / 6, 5 e 3 falhas, com conjuntos DIFERENTES a cada rodada. As que sobraram são de preparo/timeout com a máquina carregada (média 12–17 em 24 núcleos, por causa dos fluxos de produção dos canais) e passam isoladas (9/9; 24/24; 16/16). Nenhuma toca consistentemente nas funções novas
- [x] `historico.spec:165` e `reunioes.spec:32` (falhavam em 2 de 3 rodadas completas): provado que é carga. Isolados 9/9; sob 20 processos queimando CPU (load 16–30) falharam 2 de 12, exatamente esses dois, com os mesmos erros (beforeEach > 30 s; mensagem da sala não aparece em 15 s). Nenhum código de produto envolvido
- [x] Suíte unitária: 164 arquivos, 1602 testes passando

- [x] Bug de src achado pelo E2E novo: o servidor repassava o id de rascunho `sessao-<ts>` do front ao motor como conversa a retomar (só o claude-sdk escapava, por exigir UUID); com outros motores o histórico ficava sob o id de rascunho e o chat voltava VAZIO. Corrigido com `idConversaNativo` (runtime-service.ts) em stream.ts, conversa.ts e runtime-service.ts; teste `tests/secretario-id-conversa.test.ts`
- [x] Suíte unitária final: 166 arquivos, 1606 testes, tsc limpo (`-p .` e `-p tsconfig.web.json`); daemon reiniciado com o build final
- [x] REATTACH-BACK: depois de sair da tela durante uma aprovação, o front pode reassinar o turno vivo: `GET /secretario/sessoes/:id/eventos?workspace=&desde=N` (SSE) + cabeçalhos `x-oc-log-entradas`/`x-oc-em-execucao` em `/mensagens`; emissor `EventLog.assinar`, tradução única em `sse-eventos.ts`. Testes: `tests/event-log-assinar.test.ts`, `tests/secretario-eventos.test.ts`. Falta o consumo no front (REATTACH-FRONT)
- [x] REATTACH-FRONT: ao voltar para uma conversa com `x-oc-em-execucao: 1`, o hook do runtime reassina `/eventos?desde=<x-oc-log-entradas>` e continua a mesma mensagem do assistente (cartão pendente preservado, `aprovacao_resolvida` atualiza ao vivo, fim/erro/inativo tira o estado 'running'; desmontar/trocar de sessão aborta o SSE; 1 repetição em erro de rede). Código: `runtime/reassinar.ts`, `runtime/sse-consumidor.ts` (consumidor SSE único, também usado por `turno-stream.ts`), `buscarHistoricoComMeta`. Testes: `tests/unit/web/chat-runtime-reattach.test.ts`. Botão parar em turno reassinado chama `POST /secretario/sessoes/:id/cancelar` (`cancelarTurnoReassinado`). NÃO visto no navegador

**Rodada 3 — "corrija tudo" (2026-10-20, noite)**
- [x] PC travado 2x: causa = falta de memória (journald "Under memory pressure" antes da queda; 14 GB de RAM, 2 GB de swap, 12 núcleos, canais renderizando vídeo). Parte minha: mandei rodar 20 queimadores de CPU e deixei sessões rodando suítes em paralelo. Correção: `scripts/rodar-pesado.sh` (uma tarefa pesada por vez, limite de memória de 5G via cgroup — estourou, só ela morre —, nice/ionice, recusa começar com pouca memória). Regra no `CLAUDE.md`
- [x] Resposta final aparece AO VIVO depois de aprovar, sem recarregar (REATTACH): `GET /secretario/sessoes/:id/eventos` + cabeçalhos em `/mensagens` + front reassina o turno. Testado no navegador: pedir → sair → voltar → aprovar → resposta final apareceu sozinha, cartão "Aprovado."
- [x] "Parar" de um turno reassinado: a rota que já existia (`POST /secretario/sessoes/:id/cancelar`) passou a abortar o turno vivo (uma rota só; minha 1ª versão era duplicata e ficava inalcançável). Teste novo; botão do front ligado a ela
- [x] Servidor travado em laço (incidente de 16 min a 110% de CPU, sem causa conhecida): WATCHDOG do event loop (`src/server/event-loop-watchdog.ts`, ligado no `serve`: se a thread principal parar > N s, grava a pilha em `~/.opencorp/logs/watchdog-*.json` e encerra para o supervisor reiniciar) + probes de login assíncronos (não congelam mais o servidor em GET /api/motores). A causa original continua desconhecida; agora, se repetir, haverá diagnóstico e recuperação automática
- [x] E2E robusto: fator de tempo (`E2E_TIMEOUT_FACTOR`, padrão 3), retries 0, seeds com espera de prontidão e retry só de transporte. Rodada completa no build novo: 346 passaram / 1 falhou / 11 ignorados, sem travamento. A falha (`sessao-continuar-duplicar:85`, "agente não encontrado") era do teste: o seed engolia erros (`.catch(() => undefined)`). Novo helper `criarRecurso` (falha alto; reconhece "já existe", que o servidor responde com 422). Spec: 18/18 em 6 repetições
- [x] Publicado: https://github.com/MrJc01/crom-opencorp-claude (público, repositório temporário; README aponta o original `crom-org/opencorp`)

**Rodada 3b — o PC lento e o servidor de teste morto (2026-10-20, noite)**
- [x] Servidor de teste morto no meio do E2E: o watchdog gravou o diagnóstico (`event loop sem batimento por 20929 ms`, com `POST /workspaces` em andamento 17 s; o inspetor NÃO conseguiu pausar a thread principal em 3 s, ou seja, ela estava presa numa chamada de sistema síncrona, não executando JS). Causa: `WorkspaceManager.criar` copiava o esqueleto inteiro com `cpSync` (síncrono) e o meu `rodar-pesado.sh` rodava o teste com I/O "idle" (`ionice -c3`), então o disco ocupado deixou a cópia parada por >20 s. Correção: cópia/mkdir/rename/rm assíncronos em `criar`; script passa a usar ionice classe 2 nível 7 e nice 10 (a proteção do PC é o limite de memória, não a prioridade mais baixa possível)
- [x] Disco do dono (diagnóstico com dados): SSD `KA-SSD-512` 87% cheio (59 GB livres), escritas pequenas levam 120–260 ms mesmo com pouco tráfego, sem erros no kernel; a pressão de I/O do PC chegou a 85%. Nas rajadas medidas, quem mais movimentava o disco era `mintUpdate` (687 MB lidos em 2 min) e `flatpak-update-worker` (até 68 MB/s), ou seja, atualização do sistema em segundo plano; o OpenCorp (scheduler/serve) escreve pouco (≤1,2 MB/s). O E2E que eu rodava no disco piorava tudo
- [x] E2E e testes agora não tocam no disco: `scripts/e2e-seguro.sh` roda o Playwright com HOME/TMPDIR/OPENCORP_HOME em `/dev/shm` (RAM; caminho `/dev/shm/opencorp-e2e` em 12 arquivos de teste) e `scripts/rodar-pesado.sh` manda o TMPDIR de tsc/vitest/build para a RAM
- [x] Removidos 9 worktrees extras do `crom-animate-agent` (limpos, sem commits fora da main; ~570 MB); sobrou só o repositório principal
- [x] `sessao-continuar-duplicar:85` (E2E): era o seed engolindo erros; helper `criarRecurso` falha alto e reconhece "já existe" (HTTP 422)
- [~] Limpeza autorizada pelo dono: caches regeneráveis (`huggingface`, `uv`, `.npm`, `go-build`) em lotes com freio de latência (disco com escritas de até 6,5 s); pendente: inspecionar `.var` (tem dados de apps, não só cache), vídeos dos canais (só o já publicado/intermediário) e artefatos gerados dos repositórios grandes. Antes de decidir o resto: liberar espaço do SSD (meta < 75%): caches regeneráveis ~`.cache/go-build` 11 GB, `.npm` 3,8 GB, `.cache/uv` 2 GB, `.cache/huggingface` 2,1 GB; `.var` (flatpak) 22 GB; vídeos em `~/.opencorp/workspaces/yt-factory-01` (16 GB) e `fundao` (9,9 GB); repositórios grandes em `Documentos/GitHub` (`crom-cutvideo` 13 GB, `claude-code-open` 6,6 GB, `crom-videos` 5,9 GB, `appshop` 5,3 GB). Conferir a saúde do SSD: `sudo smartctl -a /dev/sda`. Evitar atualizações do sistema durante o trabalho
- [x] **E2E completo em RAM no build final: 347 passaram, 0 falharam, 11 ignorados (falta de binário), 6,9 min, servidor de teste morto 0 vezes** (primeira rodada completa sem nenhuma falha)
- [x] Falha intermitente de `reunioes.spec:33` ("enviar mensagem na sala"): 3 causas achadas com evidência do trace (sem POST de mensagem, textbox vazia): (1) o TESTE escrevia em `main textarea`.last(), que durante o fechamento do modal de convocação era o `textarea` do MODAL (o texto se perdia; corrigido esperando o modal sair e usando o placeholder da caixa da sala); (2) bug real do produto em `ReunioesView`: uma consulta de polling iniciada ANTES do envio podia chegar depois e sobrescrever a lista, apagando a mensagem otimista (agora `enviandoRef` é checado na chegada da resposta). 12 repetições: 3 falhas → 36/36 passaram

**A fazer — pendentes de antes**
- [x] `tests/runs-robustos.test.ts` instável sob carga: causa = corrida do teste (escrevia hitl_pendente antes do run gravar pid/status no meta.json); corrigido no teste (12/15 falhavam sob carga, 15/15 passam)
- [x] Suíte E2E (Playwright) rodada isolada (porta 4399, OPENCORP_HOME=/tmp/opencorp-e2e); ver resultado em .claude/notes/frentes-paralelas.md

**MOTOR-UI (2026-10-20, feito; tsc web+raiz e vitest verdes, não visto no navegador)**
- [x] Front sem motor/modelo fixo: `lib/chat/constants.ts` e `agents/constants.ts` sem listas de motores/modelos (eram código morto ou fixos); drawer de agentes lista os motores do registry via `useMotoresCatalogo`
- [x] `EngineAuthModal`: textos/fluxo de login por motor vêm de `/api/motores/:id/auth-instructions` (manifest `details.auth`/`details.login` ou credentials-bridge); sem ids fixos
- [x] `/api/motores` expõe `manifest` (limits, modelPrefixes, instructionFiles, toolPolicyModes) e `auth` por motor

**Futuro (só anotado)**
- Voltar ao opencorp original com o aprendido, trocando só o motor (não nesta sessão)
- [x] Usar o openheinerss ("Open Harness") como harness alternativo: adaptador `openheinerss` (JSON-RPC/STDIO) registrado, opcional; falta só ligar workspaces a ele no front/config (modelo `harness:modelo`) e WebSocket
- Fundão: confirmar qual publicador é o atual (`publicar_youtube_api.py` vs `publicar_youtube.py`); limpar `geckodriver.log`
- yt-factory-01: CLAUDE.md diz boletim às 13:00, fluxo roda 13:15 — alinhar

## ▶️ Retomar
A+B feitas e testadas no navegador. Falta: MOTOR-UI (constantes do front), conferir `credentials-store`, decidir sobre `hitl.ts` duplicado, abrir o Secretário numa conversa antiga (sem log) e no Dock (Ctrl+J), testar o domínio no navegador (tela Ativos), rodar E2E. Notas técnicas em `.claude/notes/estado.md`. Validar com `npx tsc --noEmit -p .`, `npx vitest run`, `npm run build`; reiniciar `systemctl --user restart opencorp-daemon` após build. Sem commit/push sem pedido do dono.

- [x] MOTOR-CRED (2026-10-20): credenciais por motor via política registrável (manifest), provedores do llm-client em `models/providers.ts`, heurísticas de modelo do model-resolver em tabelas. tsc limpo, vitest 1570 verdes.
