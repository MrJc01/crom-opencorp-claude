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
