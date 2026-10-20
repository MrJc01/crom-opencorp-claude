# Estado (atualizado 2026-10-20)

## Diagnóstico do Secretário web
- Front em src/web/features/chat. @assistant-ui/react 0.15 já instalado, usado via useLocalRuntime (secretary-runtime-adapter.ts:561).
- CAUSA do "volto ao chat e perco aprovações": (a) EngineApprovalCard.tsx:29 guarda status em useState local; (b) histórico vem de /secretario/sessoes/:id/mensagens, proxy do opencode, sem endpoint para claude-sdk (sessions.ts:669); (c) aprovações do claude-sdk só em memória (claude-sdk-adapter.ts:456), não usam approvals-store.
- Abas confusas: lógica duplicada em SecretarioView.tsx e SecretarioDock.tsx; chaves localStorage duplicadas; HistoryChatTab confunde; aprovação em 2 caminhos (EngineApprovalCard e HitlApprovalToolUI).
- SSE próprio (inicio/delta/acao/aprovacao/fim/erro) em stream.ts:316-355, sem IDs estáveis nem retomada.

## Agnosticismo
- Sem import do SDK fora de engines, mas vazam: session-manager.ts:1121,1326; execution-driver.ts:245; paths.ts:118; credentials-store.ts:35; catalog.ts:79-92; model-resolver.ts; secretario/helpers.ts e context-builder.ts (modelo fixo); EngineAuthModal.tsx e constants do front.
- Domínio fixo só em packs-store.ts:62,84 e AtivosView.tsx:126.
- EngineAdapter/AgentEvent: faltam política de ferramentas, evento de artefato/sessão, timeouts/flags no manifest.
- "Open Harness": candidato /home/j/Documentos/GitHub/openheinerss (Go, JSON-RPC). CONFIRMAR com o dono.

## Próximo passo
Plano em 3 frentes (ver resumo ao dono): A) histórico+aprovações persistentes, B) UI do Secretário sobre Assistant UI com uma só fonte de abas, C) camada agnóstica de motor.
Pendências antigas: runs-robustos instável; E2E não rodada.
