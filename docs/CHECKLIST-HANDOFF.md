# Checklist de handoff — o que falta fazer

Documento para retomar o trabalho com outro agente/sessão. Estado de referência: `main` em 27/09/2026
(após os commits de estabilização do E2E, P-02, P-03, doctor e correções de UI).

Para o histórico da arquitetura multimotores veja [PENDENCIAS-MULTIMOTORES.md](PENDENCIAS-MULTIMOTORES.md)
e o [plano de execução](PLANO-EXECUCAO-ARQUITETURA-MULTIMOTORES.md).

---

## 0. Como validar o estado antes de começar

```bash
npm ci
npx tsc --noEmit -p .          # deve sair 0
npx vitest run                 # deve estar 100% verde (fora os skipped)
npm run build
# E2E (Chromium do ambiente; CI=1 sobe servidor novo na porta 4399 com OPENCORP_HOME=/tmp/opencorp-e2e)
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome CI=1 npx playwright test --timeout=15000
```

Última medição: `tsc` limpo, `vitest` verde; E2E — `workspace`, `workspaces` e `multi-engine-orchestration`
verdes após as últimas correções; a execução completa anterior tinha 7 falhas (todas tratadas depois),
17 puladas (inclui os `fixme` abaixo) e 332 passando.

- [ ] Rodar a suíte E2E **completa** mais uma vez e confirmar 0 falhas (a última volta completa foi antes das correções finais).
- [ ] Se aparecer falha intermitente, investigar a causa (não marcar como flake nem desativar teste).

Dicas do E2E:
- `tests/e2e/fixtures/bin/opencode` é um **OpenCode falso** (`fake-opencode-cli.ts`) colocado no `PATH` pelo `playwright.config.ts`; responde `serve`, `run` e `--version`.
- `global-setup` força `execution_driver: "host"` (sem sandbox/D-Bus no container).
- `helpers.logado(...)` é **assíncrono** — sempre usar `await`.

## 1. Depende do usuário (contas, cota, publicação)

- [ ] **P-01** — probe real do Codex: `OPENCORP_REAL_PROBES=codex OPENCORP_PROBE_CODEX_MODEL=<modelo> npm run test:real`.
- [ ] **P-08** — conversa real via ACP com Copilot e MiMo (login + `npm run test:real`, ver PENDENCIAS).
- [ ] **P-09** — seleção de modelo do Copilot (`session/set_config_option`); se não houver seletor, usar `--model` em `launchModelArgs` (`src/core/engines/acp/vendors.ts`).
- [ ] Botão **"Teste funcional"** (Configurações › Motores) com motor real autenticado.
- [ ] **P-06** — instalação gerenciada para outros motores, só com SHA-256 publicado pelo fornecedor.
- [ ] **P-11** — publicar duas versões menores com o tradutor legado; remoção do legado só na v2.0.0 e a partir de 24/11/2026 (checklist em PENDENCIAS §4).
- [ ] Decidir se o remoto `crom` (`crom-org/opencorp`) deve receber o `main` (hoje só `origin` = `MrJc01/crom-opencorp` é atualizado).

## 2. Funcionalidades que existiam na UI antiga (SolidJS) e sumiram na reescrita React

Os testes E2E correspondentes estão marcados com `test.fixme` e documentados no próprio arquivo.
Ao implementar cada item, **remova o `fixme`** e faça o teste passar.

| Feito | Funcionalidade | Teste `fixme` |
|---|---|---|
| [ ] | Chat: input que cresce com quebras de linha e encolhe ao perder o foco | `tests/e2e/ia-perguntas-opcoes.spec.ts` (redimensionamento) |
| [ ] | Chat: histórico paginado (últimos 2 turnos + scroll infinito para cima) | `ia-perguntas-opcoes.spec.ts` (carregamento paginado) |
| [ ] | Chat: botão "editar prompt" que devolve o texto ao input | `ia-perguntas-opcoes.spec.ts` (editar prompt) |
| [ ] | Chat: fila de prompts enquanto o agente roda (editar, excluir, disparar) | `ia-perguntas-opcoes.spec.ts` (fila de prompts) |
| [ ] | Chat: botão "adiantar" que interrompe e dispara o próximo da fila | `ia-perguntas-opcoes.spec.ts` (fila — adiantar) |
| [ ] | Secretário: toggles na barra superior e preview web | `tests/e2e/secretario-toggles-preview.spec.ts` |
| [ ] | Home: aba Fluxos com "Últimas execuções" e status | `tests/e2e/fluxos-historico.spec.ts` (C1) |
| [ ] | Lista de fluxos: selo com status da última execução | `tests/e2e/tempo-real.spec.ts` |
| [ ] | Docs: menu lateral recolhível | `tests/e2e/web/docs.spec.ts` |

Outras lacunas percebidas (sem teste dedicado):

- [ ] Home antiga: KPIs, abas, barra de comando e bloco "A Seguir".
- [ ] Quotas/limites dos motores atualizados ao vivo na UI.
- [ ] Studio: visão dividida Chat/Canvas.
- [ ] Barra superior: cartão de execução ao vivo.
- [ ] Mini-Apps: o modo chat ainda é placeholder.
- [ ] `TeamCard` mostra 0 membros para times no formato legado.
- [ ] Toasts cobrem controles (ex.: botão de enviar da reunião) — reposicionar ou deslocar a pilha de toasts.

## 3. Qualidade / dívidas técnicas

- [ ] Estender a suíte de acessibilidade (`tests/e2e/a11y-motores.spec.ts`, axe-core) para Chat, Fluxos e Home.
- [ ] Preencher os marcos da seção 14 do plano (datas e commits) conforme os itens do §1 forem fechados.
- [ ] Revisar `SessionManager` — execuções de fluxo rodam **no próprio processo**; `pidSinalizavel()` impede sinalizar o PID do servidor. Considerar gravar `pid: null` para execuções em processo, em vez do PID do servidor.

## 4. Já resolvido nesta rodada (para referência)

- [x] **P-03** — desconectar o motor padrão exige `novoPadrao` (409 com `candidatos`); a UI pergunta o substituto.
- [x] **P-02** — metadados das sessões Codex persistidos em `~/.opencorp/codex-sessions.json`; thread retomada com `thread/resume`.
- [x] **doctor** — verifica os motores configurados (`checkConfiguredEngines`), não mais "opencode no PATH".
- [x] **P-12** — E2E reescritos para a UI React; falhas restantes corrigidas ou marcadas `fixme` (lista no §2).
- [x] **P-13** — suíte axe-core para Configurações › Motores; contraste corrigido.
- [x] Bug crítico: cancelar um fluxo (ou o reaper de zumbis) mandava SIGTERM para o próprio servidor.
- [x] Exportar/importar tarefas em `.corp` usa o banco unificado (`opencorp.db`).
- [x] Tela de login (`AuthGate`), `?token=`, redirecionamento de links `#/` antigos, token em chamadas `fetch` diretas.
- [x] Cartão de perguntas da IA (`ask_question`/`question`), várias perguntas e resposta livre.
- [x] Modelos de fluxo válidos; síntese do fanout recebe as saídas paralelas.
- [x] Login dos motores (instruções por motor), reuniões sem agentes inativos, histórico (painel/Esc/aba Resultado),
      menções `@` com agentes reais, card de aprovações pendentes na Home, `SettingRow` sem sobrescrever edição.
- [x] Seletor do motor de conversa do Secretário por workspace (`default_conversation_engine`).
