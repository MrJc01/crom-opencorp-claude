# Plano: provedores grátis no motor claude-sdk

Pedido do dono (2026-10-31): "use o sdk do claude agent usando modelos free". O executor continua sendo o
claude-sdk; ele aponta para endpoints grátis compatíveis com a Anthropic. Nada de conta nem modelo da
Anthropic/Claude. Harnesses do openheinerss (agy, codex, opencode, aider) ficam FORA desta entrega.

## Estado verificado (2026-10-31)

- `src/core/engines/provedor-claude.ts`: arquivo `~/.opencorp/provedores.json`, tipos, pool e resolução. `tsc` ok.
- `src/core/engines/rotacao-provedores.ts` + `runners/claude-sdk-cli.ts`: troca de membro quando a cota esgota.
  Testes em `tests/provedor-rotacao.test.ts`.
- `src/core/engines/provedores-gratis.ts`: regras de cadastro (só `compativel`/`pool`, só modelo `:free`/`-free`).
  Compila. Ainda sem testes, sem rota HTTP e sem tela.

## Critérios de aceite

1. A tela só edita provedores `compativel` e pools. `assinatura` e `api` não aparecem nem podem ser alterados por ela.
2. Modelo cujo id não termina em `:free` ou `-free` é recusado, com mensagem clara.
3. A listagem nunca devolve o valor da chave; só diz se ela está definida.
4. Editar sem digitar chave mantém a chave gravada.
5. Remover o provedor ativo é recusado. Remover um membro tira ele dos pools.
6. Em Configurações > Motores: cadastrar, editar, remover, montar pool de rodízio e definir o ativo.
7. `tsc` (servidor e web) e os testes de provedor passam. Sem commit.

## Fases

| fase | entrega | teste | status |
|---|---|---|---|
| 1 | regras e persistência (`provedores-gratis.ts`) | `tests/provedor-gratis.test.ts` (feito, verde) | concluída |
| 2 | rota `GET/POST/DELETE /api/provedores-gratis...` em `routes/config.ts` | `tests/provedor-gratis-rota.test.ts` (feito, verde) | concluída |
| 3 | seção "Provedores grátis" em Configurações > Motores (`ProvedoresGratisSecao.tsx`) | `tsc -p tsconfig.web.json` (sem erro) | concluída |
| 4 | verificação e entrada no LEIAME | `tsc` servidor e web; 55 testes de provedor verdes | concluída (sem commit; daemon ainda não reconstruído) |

## Fora desta entrega

- agy, codex, opencode, aider pelo openheinerss: depende de confirmar se são grátis e de ligar o engine a um papel da esteira (fase 5 do plano do conector).
- `openrouter-haiku` (Haiku pago via OpenRouter) continua no arquivo; remover depende de OK do dono.
