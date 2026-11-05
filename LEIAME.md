# LEIAME — o que o dono quer do opencorp-claude

Leia isto antes de qualquer trabalho numa sessão nova. Atualize sempre que o dono pedir algo novo ou decidir algo.
Detalhes técnicos estão no `CLAUDE.md` (deste repo e de cada canal); aqui fica o **porquê** e o **combinado**.

## Quem é e como gosta de trabalhar

- Fala português, mensagens curtas e diretas. Quer respostas em português simples, sem enrolação.
- Quer **tudo funcionando sozinho**, completo, "sem interferência", para depois expandir para outros projetos.
- Não quer perguntas desnecessárias nem desculpas: decidir com bom senso, fazer, conferir o resultado real e contar.
- Detesta trabalho pela metade e ter que pedir de novo para consertar.
- Quer que o Claude da sessão aja como **especialista que gerencia os agentes** (Haiku 5.5) do opencorp.
- Gosta de relatório para ler (ex.: `docs/relatorios/`).
- Usa o próprio PC (Linux), deixa rodando de fundo, às vezes vai dormir e espera achar tudo pronto.

## O que é o projeto

Fork privado do OpenCorp que usa o **Claude Agent SDK** (login do claude.ai, plano Pro, sem API key) como motor dos
agentes, do Secretário e dos fluxos. Uso só do dono. Não fazer `git push` nem mexer no repo original
`/home/j/Documentos/GitHub/opencorp`. Commits só quando ele pedir.

## Para que serve este fork (decisão de 2026-10-20)

O dono criou este fork para **aprender e organizar tudo com o Claude Code/SDK** e depois **voltar ao OpenCorp original**
com o que foi aprendido, trocando só o motor de IA. Por isso o sistema precisa ser **agnóstico de motor e de domínio**:
o OpenCorp serve para qualquer empresa (não só fundão/bitcoin) e o motor do Claude vira um adaptador entre outros.
O próximo motor previsto é o **Open Harness = `openheinerss`** (`/home/j/Documentos/GitHub/openheinerss`, Go, JSON-RPC).
Voltar ao opencorp original **não é para esta fase**.

## Os canais (o que mais importa hoje)

| Canal | Workspace | Assunto |
|---|---|---|
| **Bit Proibido** (@bitproibido) | `~/.opencorp/workspaces/yt-factory-01` | Tecnologia e IA, Shorts + boletim longo diário + blog bitproibido.wp.crom.run |
| **Fundão** (@fundao-fofocao) | `~/.opencorp/workspaces/fundao` | Fofoca: nacional estilo Choquei, internacional e política brasileira |

O que ele pediu e foi combinado:
- **Vídeos bonitos com Remotion** (não o visual antigo de cards). Render em `~/.opencorp/remotion-shorts`.
- **Nada de conteúdo ruim**: agentes olham as fotos e conferem os fatos. Proibido inventar post/tweet/fala/número
  (já houve tweet falso da Thaíde e texto de template no vídeo; esses vídeos ficaram privados).
- **1 vídeo por hora** em cada canal (horário cheio), pela API oficial do YouTube. Boletim do Bit Proibido às 13:00.
- **Pauta reprovada não pode deixar buraco**: a esteira pede outra na hora.
- **Fundão — rotação de temas**: a cada 4 vídeos ~1 política brasileira, ~1 fofoca internacional, ~2 fofoca nacional
  estilo Choquei. Política sempre apartidária, os dois lados, só fonte séria, sem deboche e sem pedir voto.
- **Kanban da interface preenchido**: cada pauta em andamento aparece em "fazendo" com o agente da etapa.
- **Economia**: gastar pouco do limite do Claude (agentes no Haiku 5.5, prompts enxutos, ler só o necessário).
- **Rodar de fundo e voltar sozinho após reiniciar o PC** (serviço systemd `opencorp-daemon`).
- **Conta própria do Claude para o opencorp**: `~/.opencorp/claude-conta` (plano Pro), separada da
  conta do Claude desktop. Trocar: `CLAUDE_CONFIG_DIR=/home/j/.opencorp/claude-conta claude auth login`.

## Decisões já tomadas (não reabrir sem motivo)

- Vídeos ruins antigos ficam **privados** no YouTube; apagar de vez é com o dono, pelo Studio (exclusão é permanente).
- Selenium (upload não oficial) abandonado; só API oficial (projeto Google `bitproibido-upload`, cota de 100
  envios/dia dividida entre os dois canais).
- Ciclo autônomo antigo (auto-evolução falsa) foi substituído por saúde da esteira + relatório semanal real.
- Posts antigos do blog que copiavam matérias em inglês foram para rascunho; artigos novos saem só de boletim aprovado.
- Todos os agentes no Haiku 5.5 (Sonnet gastaria muito do limite Pro).

## Como a esteira funciona (resumo para explicar ao dono)

pautador (de hora em hora) → roteiro → checador de fatos → coleta de fotos + curador que olha as imagens → vídeo no
Remotion → revisor que olha os quadros → publicador (1 por hora, só aprovado) → blog (Bit Proibido).
Estado: `node scripts/estado_pauta.mjs --resumo` no workspace; boletim: `node scripts/estado_boletim.mjs`.

- **Secretário web sobre Assistant UI**, com histórico e aprovações que sobrevivem a sair da tela: o servidor grava um log
  por conversa (`~/.opencorp/secretario-log/<ws>/<sessao>.jsonl`, `src/core/engines/event-log.ts`) e o histórico é
  reconstruído dele (conversas antigas: transcrição do SDK). Com aprovação pendente, sair da tela NÃO aborta o turno.
- **Trabalho em paralelo sem duplicar código**: antes de criar função, `grep` e ler `.claude/notes/mapa-funcoes.md`;
  cada frente só edita os arquivos dela (`.claude/notes/frentes-paralelas.md`). Modelos: Sonnet orquestra, Opus consulta,
  Haiku executa (skill `orquestra-sonnet-opus-haiku`).
- `claude-sdk` usa o login do plano, **nunca** ANTHROPIC_API_KEY (mudaria a cobrança).

## Riscos conhecidos

- Limite de uso do plano Pro pode parar os agentes por algumas horas (retoma sozinho).
- PC desligado ou sem internet = nada roda.
- Ao mexer em `registries/pautas.json`, usar sempre `comPautas()`/`scripts/pauta.mjs` (gravar cópia velha já apagou pautas).

## Ideias e pedidos ainda em aberto

- (sugerido, não pedido) produzir menos de madrugada se o limite do Claude continuar estourando.
- (sugerido) checador e revisor no Sonnet 5.5 se a qualidade cair — custa mais limite.
- Expandir o mesmo modelo de esteira para outros projetos/canais quando o dono pedir.

## Registro de pedidos (mais recente primeiro)

- 2026-10-31 — pedido: os dois canais a 100% depois das falhas de render das 17:00, 18:00 e 18:30. Causa provável (o erro não era guardado): `rodar-pesado.sh` exige 4,5 GB livres e desiste após 5 min; com o PC em 3 GB, as 3 tentativas estouravam os 15 min do nó. `renderizar.mjs` agora renderiza leve quando há menos de 6 GB livres (mínimo 2,5 GB, teto 3,5 GB, concorrência 2) e registra o erro de cada tentativa. `produzir-video*` com `timeout -k 30 1500` (mata o grupo todo, sem órfão segurando a fila) e 26 min no nó. `ao_falhar` aceita reserva de até 36 h, ainda limitada por `max_idade_noticia_horas`. Backups em scratchpad `bk3`.

- 2026-10-31 — pedido: falha de etapa não pode deixar a hora sem vídeo. Causa das falhas das 15:10: PC sobrecarregado (`estado-4` estourou 60 s; Chrome do render estourou 25 s) e o publicador nunca rodava. Flow ganhou `ao_falhar` (comando rodado quando a execução falha; não muda o status; saída em `extras.ao_falhar`) e nó script ganhou `tentativas`/`espera_tentativa_ms`. No `yt-hora` dos dois canais: `ao_falhar` publica a reserva aprovada, `estado-*` com 180 s e 2 tentativas. `renderizar.mjs` tenta até 3 vezes (espera de 20 s e 120 s). O motivo da falha já ficava em `extras.motivo`. Teste: `tests/flow-ao-falhar.test.ts`.

- 2026-10-31 — pedido: sair vídeo toda hora. O `yt-hora` agora corrige na mesma execução: vídeo reprovado passa por `scripts/revisao_resultado.mjs` e volta uma vez (nós com sufixo `-c`). Se ainda reprovar, publica o aprovado mais recente de até 12 h (`--max-idade-min 720`), respeitando `max_idade_noticia_horas`. Sem aprovado na fila, a hora fica sem vídeo.

- 2026-10-31 — pedido: não travar mais ao reiniciar. Causa da parada da madrugada: PC reiniciou por falta de memória às 23:24 e os PIDs antigos (pidfiles e travas) passaram a ser de outros programas, então o daemon achava que já rodava (até 03:26). Corrigido com `src/utils/processo.ts` (confere se o PID é do OpenCorp, do papel certo e mais antigo que a trava), usado em daemon, scheduler, serve e trava do flow. Teste: `tests/processo-pid-reaproveitado.test.ts`; simulação de boot com pidfiles/travas velhos e `kill -9` no daemon e no scheduler: tudo voltou sozinho. Uma execução em andamento na hora da queda se perde; a próxima hora roda normal.

- 2026-10-31 (manhã) — estado: `publicar_agora=true` nos dois canais; só `yt-hora` ativo em cada um (Bit Proibido no minuto 0, Fundão no 30, UTC nos registros = BRT+3). Se o vídeo da hora é reprovado, a pauta volta para correção na rodada seguinte e o publicador sobe o aprovado mais recente de até 180 min. Erro do Claude da sessão: reprovou `vid-mvw3l43h` dizendo que a foto não era da Christina Rocha, mas a foto é dela (Commons, 2006) e a mulher da cena 1 é a Giovanna Gold; por causa disso desligou a publicação e nenhum vídeo subiu entre 08:00 e 14:30 UTC. Único defeito real: a mesma foto em duas cenas. O revisor grátis não confere identidade por rosto (limite conhecido, não incidente).



- 2026-10-31 — pedido (do dono, antes de dormir): trabalhar até os dois canais postarem vídeos atuais a cada hora com modelos GRÁTIS, 100% rodando, sem parar para perguntar; só publicar vídeo com tudo ok. Feito: daemon reconstruído e reiniciado; tela de provedores grátis no ar; `publicar_agora` desligado e depois ligado no yt-factory-01 (Bit Proibido). Primeiro vídeo do Bit Proibido conferido nos quadros, revisado (nota 8) e publicado: https://www.youtube.com/watch?v=2qIXdLxCefY. Corrigido o título que saía com `#...` (`scripts/produzir_video.mjs`, sufixo só entra se couber em 100 caracteres). Fundão: `yt-hora` rodando; a publicação dele fica desligada até eu conferir o primeiro vídeo. Pendências: rodízio grátis depende do OpenRouter (zen1 sem cota até 2026-11-01 00:00 UTC) e o `openrouter-haiku` segue no provedores.json fora do rodízio.

- 2026-10-31 — pedido (confirmado): o executor é o Claude Agent SDK apontando para endpoints GRÁTIS, não os harnesses do openheinerss. Feito: `src/core/engines/provedores-gratis.ts` (só compatível e pool; só modelo `:free`/`-free`; chave nunca volta na listagem; editar sem chave mantém a gravada), rota `/api/provedores-gratis` em `routes/config.ts` e seção "Provedores grátis (Claude Agent SDK)" em Configurações > Motores (`components/ProvedoresGratisSecao.tsx`). Testes: `tests/provedor-gratis.test.ts` e `tests/provedor-gratis-rota.test.ts`; 55 testes de provedor passam; `tsc` do servidor e do web sem erro. Plano e status em `.claude/notes/plano-provedores-gratis.md`. Nada commitado. A tela só aparece no daemon depois de `npm run build` e reinício do serviço. Pendências: agy/codex/opencode/aider ficam fora (dono confirma se o codex-conta2 e o agy são grátis); `openrouter-haiku` (Haiku pago via OpenRouter) segue no provedores.json, precisa de OK do dono para sair.

- 2026-10-31 — pedido: OpenCorp funcionando completo com modelos e provedores GRÁTIS, com tela em Configurações para conectar provedores/harnesses grátis e contas para rotacionar entre elas. Regra do dono: NADA de conta ou modelo Claude/Anthropic ("só provedor e modelos free"). Feito e desfeito: pool de contas de Claude Code lendo engine-accounts.json, campo de URL para Claude na tela, rota de provedor ativo — tudo removido do código. Mantido: daemon corrigido (pidfile obsoleto fazia loop de reinício; `pidVivo` agora confere se o processo é do OpenCorp; teste em tests/daemon-pidvivo.test.ts); pool grátis (OpenRouter + opencode zen). Pendente, aguardando o dono: qual executor (Claude Agent SDK rodando só com endpoints grátis, ou openheinerss/opencode) e quais provedores grátis entram na tela. Nada commitado.

- 2026-10-31 — pedido: fazer o plano do conector openheinerss até a fase 6, com teste em cada fase. Feito (no repo do openheinerss, `docs/interno/PLANO-CONECTOR-UNIVERSAL.md`): fases 0 a 4 e 6 (preparada, não publicada); fase 5 parcial. Aqui no OpenCorp, adaptador `openheinerss` agora trata recusa de instrução de sistema (vai no prompt) e aceita nome de instância como harness (`codex-conta2`). Teste real com a conta codex-conta2 passou. Pendente: ligar um papel da esteira ao motor openheinerss; publicar só com OK e versão. SDK PHP e outras linguagens: não precisam para o OpenCorp; anotado para depois.

- 2026-10-31 — pedido: o openheinerss precisa ser um conector completo, com CLI e SDKs (TS, Python, PHP) padronizados, para reaproveitar harnesses de outros fornecedores (codex, agy, opencode, claude-code) com contas em rodízio. Plano com critérios de aceite, fases e testes: `openheinerss/docs/interno/PLANO-CONECTOR-UNIVERSAL.md` (ainda não iniciado; Fase 0 é reconstruir o binário, que está de 8/10 e não tem `contas`). Achados principais: anexo de imagem não existe no agy; instrução de sistema só mapeada no claude-code; `provider` só funciona no claude-code.

- 2026-10-31 — pedido: rodízio entre modelos e provedores grátis, fácil de logar contas novas. Feito: tipo `pool` em provedores.json (rotação com cooldown em `~/.opencorp/rotacao/estado.json`; cota esgotada/403 põe a conta de castigo e a chamada segue para outra). Comandos: `opencorp provedor predefinidos`, `conta <predefinido> <id> --chave ...`, `pool <id> --membros a,b`, `rotacao [--limpar]`. Validado com agente real (zen sem cota → OpenRouter). Falta: codex/agy (CLIs de outros motores) — o openheinerss gerencia contas dessas CLIs, mas não fala o protocolo Anthropic; precisa de um motor à parte.

- 2026-10-30 — decisão do dono: TUDO grátis (OpenRouter, inclusive o revisor) e publicação real LIGADA nos dois canais (`publicar_agora: true` em `registries/config_esteira.json`). Antes disso, calibração do revisor grátis contra o veredito do Haiku em 4 vídeos: inkling 0/4 (2 timeouts), nemotron 2/4 (aprovou 2 vídeos com imagem ruim). O dono escolheu assumir o risco; para desligar: `publicar_agora: false` nos dois canais. Haiku/conta2 ficou só como alternativa.

- 2026-10-29 — esteira nova: 1 fluxo por canal (`yt-hora`), de hora em hora, só notícia recente (≤ 36 h Bit Proibido / ≤ 24 h Fundão),
  publicando na hora (não agenda). Frequência: `node scripts/frequencia.mjs <min|Nh|"cron">` no workspace. Publicação real só liga com
  `registries/config_esteira.json` → `publicar_agora: true` (começou em false). Detalhes e como reativar os fluxos antigos: `docs/PLANO-PROVEDOR-GRATIS.md`.

- 2026-10-29 — erro de login: NÃO era login. As duas contas (`~/.opencorp/claude-conta` e `~/.claude`) respondem
  "Your organization has disabled Claude subscription access for Claude Code" (desde ~12:48), então agentes do Fundão/Bit Proibido falham com
  exit 1 em 2 s. É bloqueio do lado da Anthropic/organização: código não resolve a assinatura. Saídas: pedir ao admin da org para
  reabilitar, ou trocar de provedor (feito abaixo). Branch `feat/provedores-e-modelos` (main intacta).
  Provedores: `~/.opencorp/provedores.json` (`src/core/engines/provedor-claude.ts`), CLI `opencorp provedor listar|usar|adicionar|modelo|remover`.
  Tipos: `assinatura` (padrão, como antes), `api` (ANTHROPIC_API_KEY) e `compativel` (baseUrl + token: OpenRouter, GLM, DeepSeek, Kimi, Ollama...).
  Modelos: mapa por id/família/`padrao`; `OPENCORP_PROVEDOR=<id>` vale só no processo. Testado de ponta a ponta com servidor falso
  (URL base, Bearer e modelo traduzido chegam à requisição). NÃO testado com chave real. Reinicie o daemon para valer.

- 2026-10-24 — (a) PC travando: causa era o SSD genérico sem TRIM (escrita de 4 KB levava segundos); fstrim, BFQ, noatime/commit=60,
  swappiness 10, serviço do daemon com CPUWeight/IOWeight/MemoryMax e prioridade de I/O 7, teto de escrita 10 MB/s (exige `Delegate=io`
  em `/etc/systemd/system/user@.service.d/`), render com concorrência 2 (feito; detalhes na memória pc-ssd-lento-trim). Se travar de novo: trocar o SSD.
  (b) Vídeos não saíam: o revisor reprovava a promo Crom automática; revisor e checador agora a aceitam (skill, agente, CLAUDE.md e dossiê
  `scripts/folha_revisao.mjs` dos dois workspaces) e 205 pautas reprovadas desde 22/10 foram reabertas (feito).
  (c) Varredura de execuções do servidor (`iniciarPollExecucoes`) agora tem trava e 5 s; execuções com mais de 7 dias arquivadas em
  `~/.opencorp/arquivo-execucoes/` (feito). (d) Botão de pausar/retomar em cada cartão de /workspaces, com "pausado há X" e horário
  completo no title (`pausado_em` em workspaces.json) (feito). (e) Página de Analytics unificada em `/analytics` (e `/w/<ws>/analytics`):
  vários projetos juntos ou escolhidos, serviços, execuções, fluxos, erros e linha do tempo ao vivo (SSE + 10 s); API `GET /analytics/resumo`
  (`src/core/contexts/analytics/analytics-service.ts`, lê o `opencorp.db` de cada workspace em modo leitura) (feito). (f) Menu sem workspace:
  em /workspaces o menu lateral, a barra do topo e o botão do Secretário só mostram o que é global (feito). E2E `nav` e `secretario-dock`: 14 passaram (Chromium 1234 do
  Playwright reinstalado; ele tinha sido apagado do cache junto com os outros).

- 2026-10-23 — PC travando: (1) render Remotion agora passa por `scripts/rodar-pesado.sh` (um render por vez no PC todo, 6 GB de teto,
  temporários em /dev/shm, espera até 1 h na fila); concorrência do boletim 8 → 3 (`~/.opencorp/remotion-shorts/renderizar.mjs`, fora deste repo).
  O render do longo do Fundão (`produzir_longo.mjs`, Playwright) NÃO passa pela fila ainda.
  (2) Pausar workspace: campo `pausado` em workspaces.json; o scheduler pula todos os fluxos dele (fluxos seguem ligados; execução manual continua).
  UI: menu do seletor de workspace → "Pausar este workspace"; API `POST /workspaces/:id/pausa {pausado}`; SDK `workspaces.definirPausado`.
  Daemon estava desligado pelo dono; religar só quando ele pedir (`systemctl --user start opencorp-daemon`; precisa reiniciar para pegar o build).

- 2026-10-21 — pastas do Workspace IDE vazias: o teto de 15 mil nós da árvore era gasto por `.opencorp` (busca em profundidade) e as demais pastas vinham sem filhos.
  `construirArvore` (`src/server/routes/files.ts`) agora lista nível por nível; o teto só corta níveis fundos. Teste: `tests/files-arvore.test.ts`. Corrigido, sem commit.

- 2026-10-21 — interface mostrava "yt-factory-01": workspaces.json ganhou o campo opcional `nome` ("Bit Proibido", "Fundão"); o id não muda (é chave de pastas/fluxos).
  Mostrado no seletor do topo e no rodapé do menu (`useNomeWorkspace`); outras telas ainda mostram o id. Teste novo em `tests/workspace-manager.test.ts`.

- 2026-10-21 — divulgação Crom em TODO vídeo dos canais: popup de canto no meio + vinheta + propaganda Crom TV no fim (feito, fora deste repo).
  crom.run = comunidade; tv.crom.run = projeto Crom TV; YouTube @crom_run; cruzada Bit Proibido ↔ Fundão. 15 vinhetas, 5 popups,
  tudo em `~/.opencorp/promo-crom-run` (`gerar.py`, `aplicar.py`, `promo.mjs`) e cópia organizada em `~/Vídeos/Crom Promo`.
  Gancho: `remotion-shorts/renderizar.mjs` (shorts e boletim de ambos) e `workspaces/fundao/scripts/produzir_longo.mjs`; falha nunca derruba
  a esteira; `OPENCORP_SEM_PROMO=1` desliga. Vale só para renders novos. Vídeo longo recebe vários popups (1 a cada ~2 min, 2 a 5, trocando de assunto; fica na faixa do cabeçalho); Short recebe 1.
  Atraso do boletim do bitproibido (2026-10-21, corrigido em `yt-factory-01`): Shorts não usam mais o slot 13:00 (reservado ao boletim, que tenta 13:00, 13:30, 12:30);
  `agendar_boletim_10h.py` usa o próximo slot livre em vez de "amanhã 13:00"; flow `yt-boletim-upload-10h` roda `10,40 10-14 * * *` (timeout 15 min);
  `yt-boletim-diario` passa a `17 7-12 * * *`. Pendente: reprovação do revisor por "fato sem respaldo" ainda só refaz na hora seguinte; render do Fundão na mesma janela.

- 2026-10-20 — "fazer tudo": Secretário web no Assistant UI (histórico, aprovações, abas), núcleo agnóstico de motor e de
  domínio, adaptador openheinerss, READMEs dos dois canais, checklist. Feito e testado no navegador; detalhes e o que
  falta em `docs/CHECKLIST.md` (pendente: causa do servidor E2E órfão a 100% de CPU, E2E do cartão de aprovação).

- 2026-10-15 — anotar tudo num LEIAME para continuar em outra sessão (este arquivo).
- 2026-10-15 — conta específica do Claude para o opencorp (feito).
- 2026-10-15 — Kanban do fundão vazio: espelhar a esteira no quadro (feito).
- 2026-10-15 — fofoca estilo Choquei, internacional e política no fundão, fácil e explicado (feito).
- 2026-10-15 — revisar tudo para economizar e facilitar para os agentes + relatório (feito, `docs/relatorios/`).
- 2026-10-15 — 1 vídeo por hora; pauta reprovada deve buscar outra (feito).
- 2026-10-15 — deixar rodando de fundo e voltar após reiniciar (feito, serviço systemd).
- 2026-10-15 — boletim em Remotion com checagem e revisão; corrigir fluxos pausados; tudo em produção (feito).
- 2026-10-15 — agentes julgarem fotos e fatos, skills, Secretário gerenciando tudo (feito).
- 2026-10-15 — trocar visual para Remotion nos dois canais (feito).

## Registro: harnesses arquivados e Secretário (2026-11-05)
- Pedido: Secretário não funcionava; arquivar os outros harness (sem usar em lugar nenhum) e fazer todos os provedores rodarem pelo claude + config do projeto.
- Causa do Secretário: `default_conversation_engine` caía em `opencode`. Agora o padrão é `claude-sdk` (schema, workspace fundao, settings global).
- Harnesses e testes presos a eles: `archive/harnesses/` (ver o LEIAME de lá). Provedores: `~/.opencorp/provedores.json`; claude-sdk aceita qualquer modelo com provedor compativel/pool.
- Validado: tsc limpo, 163 arquivos / 1486 testes passando, build, daemon reiniciado, Secretário do fundao respondeu "ok" pelo pool grátis.
