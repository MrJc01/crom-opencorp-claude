# Mapa de funções compartilhadas (consulte antes de criar uma nova)

| Nome | Arquivo | Para que serve |
|---|---|---|
| `EventLog`, `reduzirHistorico` | `src/core/engines/event-log.ts` | Log JSONL por conversa e redutor para mensagens (histórico do Secretário) |
| `EventLog.assinar(ws, sessao, cb \| {entrada, fimTurno}) => cancelar`, `EventLog.encerrarTurno(ws, sessao)` | `src/core/engines/event-log.ts` | Emissor em memória por conversa (compartilhado entre instâncias do mesmo home), acionado por todo `anexar` com o índice da entrada; `encerrarTurno` avisa o fim (stream.ts chama no `finally`) |
| `criarTradutorSse({workspaceId, motor, sse, incluirResolucoes?})`, `resumirFerramenta` | `src/server/routes/secretario/sse-eventos.ts` | Tradução ÚNICA AgentEvent→SSE (`delta`/`acao`/`aprovacao`/`fim`/`erro`; `aprovacao_resolvida` só com `incluirResolucoes`), usada por stream.ts e eventos.ts |
| `handleEventosRoutes` | `src/server/routes/secretario/eventos.ts` | `GET /secretario/sessoes/:id/eventos?workspace=&desde=N`: reenvia o log a partir de N e acompanha ao vivo até o fim do turno; `event: inativo` se não há turno vivo |
| `useAbasSecretario(wsId, adaptador)` | `src/web/features/chat/hooks/useAbasSecretario.ts` | Hook único das abas do Secretário (View usa `?sessao=`, Dock usa estado local); devolve abas, sessaoAtivaId, selecionar, nova, fechar, atualizarTitulo, aoSessaoCriada |
| `deduplicarAbas`, `atualizarAbaAtiva`, `carregarAbasWorkspace`, `salvarAbasWorkspace`, `gerarTabKey`, `criarAba`, `lerSessaoAtiva`, `chaveAbas`/`chaveSchemaAbas`/`chaveSessaoAtiva`, `PREFIXO_SESSAO`/`PREFIXO_RASCUNHO` | mesmo arquivo | Funções puras, persistência em localStorage e constantes das abas |
| `converterMensagensBackend`, `buildAssistantParts` | `src/web/features/chat/runtime/message-converter.ts` (reexportadas por `secretary-runtime-adapter.ts`) | Histórico do backend / estado do turno -> partes do Assistant UI |
| `obterAuthHeaders`, `originAtual` | `runtime/auth-headers.ts` | Authorization da UI e origin do servidor |
| `criarEstadoTurno`, `aplicarEventoSse`, `partesDoEstado` | `runtime/sse-reducer.ts` | Redutor dos eventos SSE (inicio/delta/acao/aprovacao/fim/erro) num estado de turno |
| `executarTurno`, `executarTerminalDireto` | `runtime/turno-stream.ts` | POST do turno + consumo do SSE (gerador de estados); `!comando` no terminal |
| `atualizarMensagem`, `marcarAprovacao`, `podeSubstituirPeloServidor`, `criarMensagemUsuario/Assistente` | `runtime/chat-store.ts` | Operações puras do store de mensagens |
| `buscarHistorico`, `sessaoTemHistorico` | `runtime/history-client.ts` | GET /secretario/sessoes/:id/mensagens já convertido |
| `useOpenCorpSecretarioRuntime`, `marcarAprovacaoNoRuntime` | `runtime/secretary-runtime-adapter.ts` | Runtime `useExternalStoreRuntime` (store local + SSE + recarga do servidor); cards gravam decisão no store |
| `parsearBlocoSse`, `separarBlocosSse` | `src/web/lib/chat/secretary-stream.ts` | Parse de blocos SSE (usados também por `executarSecretarioStream`) |
| `opencorpHome`, `pathComCliLocal` | `src/utils/paths.ts` | Caminhos do OpenCorp |
| `claudeConfigDirOpencorp` | `src/core/engines/drivers/claude-config-dir.ts` | Conta Claude própria do OpenCorp (movida de paths.ts) |
| `EngineDriver.timeoutDefaults/modelPrefixes/fallbackModels/nativeSessionPassthrough` | `src/core/engines/types.ts` | Campos opcionais que o núcleo consulta em vez do id do motor (timeouts, modelos aceitos, rotação, repasse de sessão) |
| `EngineCapabilityManifest.limits/modelPrefixes/instructionFiles/credentialEnvVars/toolPolicyModes/emits`, `manifestLimits`, `manifestAcceptsModel` | `src/core/engines/manifests.ts` | Capacidades novas do manifest |
| `ToolPolicy`, `AgentRunInput.toolPolicy/resumeSessionId/systemPromptAppend/maxTurns` | `src/core/engines/ports.ts` | Política de ferramentas e resume no contrato; inclui esqueleto de adaptador JSON-RPC (openheinerss) |
| `ArtifactRef`, eventos `artifact.produced`, `session.updated` | `src/core/engines/events.ts` | Artefato e sessão nativa no `AgentEvent` |
| `OPENCORP_SANDBOX_RW_BIND` (env) | `src/core/contexts/execution/execution-driver.ts` | Caminhos graváveis no sandbox informados pelo motor (substitui OPENCORP_SANDBOX_CLAUDE_LOGIN) |
| `PREFIXOS_MODELO_SEM_CUSTO`, `FAMILIAS_MODELO_CONHECIDAS` | `src/core/contexts/agents/model-resolver.ts` | Tabelas de modelo extraídas |
| `MODELO_CONTINGENCIA_ANTHROPIC` | `src/server/routes/secretario/helpers.ts` | Modelo de contingência (env OPENCORP_MODELO_CONTINGENCIA_ANTHROPIC) |
| `PackStore`, `normalizarManifesto` | `src/core/contexts/platform/packs-store.ts` | Registro de packs dirigido por dados: lê `templates/packs/<id>/pack.json` e `~/.opencorp/packs` (sem pack embutido no núcleo); aceita chaves PT/EN; itens podem ter `template` (vitrine) |
| `templates/packs/*/pack.json` | `templates/packs/` | Manifestos: youtube-factory, sre-devops, ecommerce-ops, compliance-legal, nucleo-operacao, atendimento-cliente (exemplo de outro domínio) |
| `derivarTemplates` | `src/web/features/assets/views/AtivosView.tsx` | Monta as abas de modelos de agentes/fluxos a partir do detalhe dos packs (`/packs/:id`), sem catálogo fixo na UI |
| `publicarTurno`, `obterTurno`, `assinarTurno` | `runtime/live-turns.ts` | Turnos em andamento por sessão fora do React: chat remontado no meio do turno adota o turno vivo |
| `converterTranscricaoSdk`, `removerContextoWorkspace` | `src/core/engines/adapters/claude-sdk-history.ts` | Transcrição do SDK → mensagens do histórico (conversas anteriores ao log) |
| `ConversationRuntime.history?` | `src/core/engines/ports.ts` | Recurso opcional do motor para reconstruir histórico; a rota de mensagens usa depois do log de eventos |
| `useMotoresCatalogo`, `carregarMotores`, `motorDoModelo`, `invalidarMotores` | `src/web/lib/engines/catalogo-motores.ts` | Único cliente do front para GET /api/motores (cache): motores, manifest (modelPrefixes, limits...) e `auth` (textos de login por motor). Não crie outro |
| `perfilAuthMotor` | `src/server/routes/config.ts` | Perfil de login do motor (title/cliCommand/envVar/url/desc/login{web,codigo,importar}); lê `manifest.details.auth`/`details.login` e cai no credentials-bridge |

## MOTOR-CRED (2026-10-20)
- `credentials-store.ts`: `registerEngineCredentialPolicy`, `clearEngineCredentialPolicies`, `engineCredentialVars(engineId)`, `isKnownSecretEnvVar(name)`.
- `models/providers.ts`: `PROVIDER_DEFINITIONS` (catálogo de provedores, antes fixo no llm-client), `providerEnvVar`, `providersWithKeySources`.
- `agents/model-resolver.ts`: tabelas de dados `PARAMETROS_ESTIMADOS_B`, `TRECHOS_MODELO_TIER_S`.

## OPENHEINERSS (2026-10-20)
| Função/classe | Arquivo | O que faz |
|---|---|---|
| `OpenheinerssAdapter`, `OPENHEINERSS_MANIFEST` | `src/core/engines/adapters/openheinerss-adapter.ts` | `EngineAdapter` do Open Harness (id `openheinerss`, `serve --stdio`): runner one-shot, conversationRuntime (create/send/resume/respondApproval/close), modelCatalog por harness. Um processo residente por workspace no ProcessRegistry. Registrado em `registry.ts`; não é o padrão |
| `OpenheinerssClient` | `src/core/engines/adapters/openheinerss-client.ts` | Cliente JSON-RPC sobre `JsonRpcConnection`; `runTurn` traduz `agent.*` → `AgentEvent` (text→delta, tool_call/result, permission_request→approval.requested, usage, complete/error); aprovação via `session.permission_respond`, expira em `approvalTimeoutMs`; cancelamento via `session.abort` |
| `resolveOpenheinerssBinary`, `openheinerssInstallStatus` | `src/core/engines/drivers/openheinerss-driver.ts` | Binário: `binPath` > `OPENHEINERSS_BIN` > `/home/j/Documentos/GitHub/openheinerss/bin/openheinerss` > PATH. Ausente = `installed:false` |
| `parseOpenheinerssModel`, `openheinerssDefaultHarness` | idem | `model` do núcleo = `<harness>[:<modelo>]` (ex.: `claude-code:claude-sonnet-5-5`, `mock`); `OPENHEINERSS_HARNESS` muda o harness padrão |
| `createFakeOpenheinerss` | `tests/fixtures/fake-openheinerss.ts` | Servidor falso em memória; testes em `tests/engine-openheinerss.test.ts` (integração real com `mock` pulada se não há binário) |

## REATTACH-FRONT (2026-10-20)
| Função | Arquivo | O que faz |
|---|---|---|
| `lerEventosSse` | `src/web/features/chat/runtime/sse-consumidor.ts` | Único consumidor do corpo SSE (blocos → `{evento,dados}`); usado por `executarTurno` e `reassinarTurno`; cancela o reader ao terminar/abortar |
| `reassinarTurno`, `estadoDaMensagemBackend` | `runtime/reassinar.ts` | Abre `GET /secretario/sessoes/:id/eventos?workspace&desde` e emite `EstadoTurno` pelo mesmo `aplicarEventoSse`; estado semeado da mensagem do histórico; 1 repetição em erro; para em fim/erro/inativo |
| `buscarHistoricoComMeta` | `runtime/history-client.ts` | Como `buscarHistorico` + `logEntradas` e `emExecucao` (cabeçalhos do CONTRATO REATTACH) |
| `aplicarEventoSse` (novos casos) | `runtime/sse-reducer.ts` | `aprovacao_resolvida` {id,status} e `inativo`; `ResultadoEvento.terminou` |
| efeito de reassinatura | `runtime/secretary-runtime-adapter.ts` (`useOpenCorpSecretarioRuntime`) | Ao montar com sessão persistida: busca histórico+meta; se em execução, reassina e continua a última mensagem do assistente; não publica em `live-turns` (remontar reassina de novo); `onCancel` inerte nesse estado |
