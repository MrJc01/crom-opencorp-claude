---
name: orquestra-sonnet-opus-haiku
description: Use para trabalhar com Sonnet 5.5 como orquestrador, Opus como consultor (advisor) e subagentes Haiku como executores, reaproveitando histórico e cache.
---

# Orquestra Sonnet 5.5 + Opus (consulta) + Haiku (trabalho)

## Papéis
| Papel | Modelo | Faz | Não faz |
|---|---|---|---|
| Orquestrador | Sonnet 5.5 (sessão principal) | Entende o pedido, planeja, delega, integra, decide | Varrer dezenas de arquivos, trabalho braçal repetitivo |
| Consultor | Opus 5.5 (advisor / subagente `consultor`) | Segunda opinião em decisões críticas, arquitetura, bug teimoso, revisão final | Executar tarefas, gerar código longo |
| Executores | Haiku 5.5 (subagentes) | Buscar, ler, resumir, extrair, editar mecanicamente, rodar testes | Decidir arquitetura ou escolher entre abordagens |

Regra de ouro: Opus produz **texto curto de estratégia**; Haiku produz **volume**; Sonnet produz **decisões e integração**.

## Fluxo padrão
1. **Ler histórico primeiro** (reuso): `CLAUDE.md`, `.claude/notes/decisoes.md`, `.claude/notes/estado.md`, último handoff. Não redescobrir o que já está escrito.
2. **Planejar** (Sonnet): quebrar em tarefas independentes, cada uma com entrada, saída esperada e critério de pronto.
3. **Consultar Opus só se** a tarefa: muda arquitetura, é irreversível, tem 2+ abordagens plausíveis, ou falhou 2 vezes. Máx. ~3 consultas por tarefa grande.
4. **Delegar a Haiku** em paralelo as tarefas mecânicas. Cada prompt de subagente deve ser autossuficiente (o subagente começa sem contexto).
5. **Integrar** (Sonnet): revisar o retorno dos Haiku, corrigir, decidir.
6. **Revisão final com Opus** quando o resultado for de alto impacto.
7. **Gravar histórico**: decisões novas em `decisoes.md`, estado em `estado.md`.

## Prompt de delegação para Haiku (modelo)
```
TAREFA: <uma coisa só>
CONTEXTO MÍNIMO: <arquivos/caminhos, decisões relevantes de decisoes.md>
FAÇA: <passos objetivos>
NÃO FAÇA: não mude arquitetura, não toque fora de <escopo>
RETORNE: <formato exato, ex. lista caminho:linha + 1 frase>; máx. 300 palavras
SE TRAVAR: pare e devolva o bloqueio, não improvise
```

## Prompt de consulta ao Opus (modelo)
```
DECISÃO: <o que precisa ser decidido>
OPÇÕES: A) ... B) ...
RESTRIÇÕES: <custo, prazo, stack, decisões anteriores>
JÁ TENTADO: <o que falhou>
QUERO: recomendação + riscos + próximo passo, em até 200 palavras
```

## Configuração — Claude Code
Arquivos em `.claude/agents/` (projeto) ou `~/.claude/agents/` (global). Reinicie o Claude Code se a pasta foi criada durante a sessão.

`.claude/agents/explorador.md`
```
---
name: Explore
description: Busca e leitura de código/arquivos. Use para localizar, não para revisar.
tools: Read, Grep, Glob
model: haiku
---
Você localiza e resume. Responda curto, com caminho:linha. Nunca edite.
```
(Nomear `Explore` sobrescreve o Explore embutido, que hoje herda o modelo da sessão.)

`.claude/agents/operario.md`
```
---
name: operario
description: Edições mecânicas, renomeações, boilerplate, rodar testes e relatar.
tools: Read, Edit, Write, Bash, Grep, Glob
model: haiku
---
Execute exatamente o pedido, dentro do escopo. Se algo exigir decisão de design, pare e relate.
```

`.claude/agents/consultor.md`
```
---
name: consultor
description: Segunda opinião em decisões críticas, arquitetura, bugs persistentes e revisão final.
tools: Read, Grep, Glob
model: opus
---
Você é um consultor sênior. Não implementa. Devolve recomendação, riscos e próximo passo em até 200 palavras.
```

Sessão principal: `claude --model sonnet` (ou `/model sonnet`). Cuidado: `CLAUDE_CODE_SUBAGENT_MODEL` sobrescreve o `model:` dos agentes — não defina se quiser o consultor em Opus. Se existir o `/advisor` na sua versão, prefira-o para consultas rápidas (Opus vê o histórico inteiro sem você reescrever contexto).

Obs.: subagentes não criam outros subagentes — toda delegação sai do Sonnet.

## Configuração — API (apps próprios)
Advisor tool (beta `advisor-tool-2026-03-01`): o executor chama o Opus, e o servidor passa a transcrição completa — você não reenvia contexto.
```python
import anthropic
client = anthropic.Anthropic()
resp = client.beta.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=8000,
    betas=["advisor-tool-2026-03-01"],
    system=[{"type": "text", "text": SYSTEM,
             "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
    tools=[{
        "type": "advisor_20260301", "name": "advisor",
        "model": "claude-opus-5-5",
        "max_uses": 3,
        "caching": {"type": "ephemeral", "ttl": "5m"}
    }, *MEUS_TOOLS],
    messages=historico,
)
```
- Confirme na doc se o par Sonnet 5.5 → Opus 5.5 está na tabela de compatibilidade do advisor; se não, use o Opus mais novo listado.
- Workers Haiku via API: chamadas separadas com `model="claude-haiku-5-5"`, prompt curto e autossuficiente, saída em JSON.
- No system prompt do executor, diga **quando** chamar o advisor (antes de decisões irreversíveis, após 2 falhas, antes de concluir).

## Reuso de histórico (economia real)
- **Prompt caching**: coloque o que é estável no início (system, tools, CLAUDE.md, docs fixas) com `cache_control`; o que muda vai no fim. TTL 1h para sessões longas; 5m para rajadas.
- **Caching do advisor**: vale a pena a partir de ~3 consultas na mesma conversa.
- **Memória em arquivo** (`.claude/notes/`):
  - `decisoes.md` — decisão, data, motivo (append-only)
  - `estado.md` — onde parou, próximo passo, bloqueios
  - `handoff.md` — resumo para retomar em nova sessão
- **Compactar**: ao passar de ~60% do contexto, gere handoff e use `/compact` ou nova sessão lendo o handoff.
- **Retorno dos Haiku sempre resumido**: o ganho dos subagentes é isolar contexto; resultado longo anula isso.

## Quando NÃO delegar
- Tarefa de 1–2 passos: faça direto no Sonnet (subagente custa um arranque frio).
- Algo que depende de nuance do histórico difícil de resumir.
- Decisões: nunca no Haiku.

## Checklist ao terminar
- [ ] Retorno dos Haiku conferido por Sonnet
- [ ] Decisões críticas passaram pelo Opus
- [ ] `decisoes.md` e `estado.md` atualizados
- [ ] Testes/verificação rodados
