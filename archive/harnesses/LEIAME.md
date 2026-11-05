# Harnesses arquivados

Motores que existiam no opencorp original e foram tirados DESTE fork (que usa só o `claude-sdk`).
Nada aqui é compilado nem importado. Estão guardados para portar ao opencorp original no futuro.

- `src/engines/drivers/`: opencode, codex, crom-agente, antigravity, cursor, copilot, aider, mimo, openheinerss
- `src/engines/adapters/`: opencode, codex (+ app-server client), openheinerss (+ client)
- `src/engines/acp/`: adaptador ACP (copilot, mimo)
- `tests/`: testes e fixtures desses motores

Para reativar no original: copie de volta para `src/core/engines/...` e registre no `registry.ts`.
