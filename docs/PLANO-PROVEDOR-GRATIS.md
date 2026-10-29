# Plano: canais rodando com provedor/modelos grátis (OpenRouter) — 2026-10-29

Contexto: a assinatura do Claude Code foi bloqueada pela organização ("disabled Claude subscription access"). O motor `claude-sdk`
passou a ler `~/.opencorp/provedores.json` (`src/core/engines/provedor-claude.ts`). Ativo: `openrouter` com modelos `:free`
(haiku/padrão = `thinkingmachines/inkling:free`, sonnet = `nvidia/nemotron-3.5-super-vl:free`, opus = `nvidia/nemotron-3-ultra-550b-a55b:free`).
Publicação (yt-publicador-30min, yt-boletim-publicar-14h, yt-boletim-upload-10h) está PAUSADA nos dois canais até este plano fechar.

## Meta
Saber, com medição, se a esteira roda sozinha sem publicar conteúdo ruim; só então reativar a publicação.

## Fases (status)
| # | Fase | Como se prova | Status |
|---|---|---|---|
| 1 | Provedor configurável (assinatura/API/compatível) + mapa de modelos | `tests/provedor-claude.test.ts`, requisição real com URL/token/modelo traduzidos | feito |
| 2 | Checagem de fatos barra invenção | roteiro com citação/curtidas/prejuízo inventados: 3 modelos reprovaram | feito |
| 3 | Revisor olha cena a cena (não deixa foto errada passar) | tabela `verificacao_cenas` em revisao.json; reteste reprova o "obelisco de Roma" | feito |
| 4 | Agente "travado" que na verdade trabalha em silêncio | runner emite `· Ferramenta` no stderr a cada tool; inatividade dos nós 180 s → 420 s | feito (testar em volume) |
| 5 | Defeito visual: emoji cobrindo a última letra da manchete tabloide | still do Remotion antes/depois (`Short.tsx`) | feito |
| 6 | Medição contínua | `node scripts/relatorio-esteira.mjs` (falhas por agente/motivo, tempo mediano) | feito |
| 7 | Volume pós-correção: ≥ 10 vídeos por canal, todos olhados por mim | relatório < 10% de falhas e 0 reprovação indevida/aprovação errada | EM ANDAMENTO |
| 8 | Fundão: política e fofoca (neutralidade, nada de acusação como fato) | roteiros reais + roteiro com erro plantado | pendente |
| 9 | Boletim longo (render pesado, Playwright no Fundão fora da fila `rodar-pesado`) | 1 boletim de cada canal | pendente |
| 10 | Liberação: reativar publicadores | critérios abaixo; `opencorp -t <ws> flow activate <flow>` | pendente |

## Critérios para reativar a publicação
- Falhas de agente ≤ 10% em ≥ 30 execuções seguidas (por `relatorio-esteira.mjs`).
- Nenhum vídeo aprovado com fato inventado, foto errada ou texto cortado entre os que eu conferir (amostra mínima: 10 por canal).
- Limite do OpenRouter: 1000 chamadas grátis/dia; acompanhar `free_model_daily_requests` (GET /api/v1/auth/key).
- Rollback: `opencorp provedor usar assinatura` quando a organização reativar o acesso.

## Riscos conhecidos
- Modelo grátis é mais lento e irregular que o Haiku; a esteira só repete no ciclo seguinte (15 min).
- A chave do OpenRouter está em `~/.opencorp/secrets/openrouter.env` (permissão 600) e foi exposta uma vez na conversa: trocar.
- O vídeo `vid-mvtpwrnw` (Bit Proibido) já estava agendado no YouTube para 18h do dia 29/10 antes da pausa.

## Fluxo único `yt-hora` (pedido de 2026-10-29: postar na hora, só notícia recente, 1 fluxo por canal)
Fora deste repo, em `~/.opencorp/workspaces/<ws>`: todos os fluxos antigos foram pausados (lista em `registries/fluxos_desativados.json`,
reativar com `opencorp -t <ws> flow activate <id>`). Ativo só `yt-hora` (Bit Proibido no minuto 0, Fundão no minuto 30):
`expirar-velhas → pautar (a notícia mais quente das últimas 12 h) → sanitizar → roteiro → fatos → imagens → vídeo → revisão → publicar-agora`.
- **Frequência**: `node scripts/frequencia.mjs 60` (ou `30`, `2h`, ou cron entre aspas) no workspace; sem argumento mostra a atual.
- **Frescor**: `registries/config_esteira.json` → `max_idade_noticia_horas` (Bit 36, Fundão 24). `esteira.mjs` descarta pauta velha e
  produz primeiro a pauta mais nova. `pautador_sob_demanda: false` impede o pautador antigo de ser acionado por fora do fluxo.
- **Publicação imediata**: `publicar_youtube.py --agora` (Fundão: `publicar_youtube_api.py --agora`) sobe como público o Short aprovado mais
  recente (≤ 180 min). Chave de segurança: `config_esteira.json` → `"publicar_agora": false` = só simula; mude para `true` para valer.
- Boletim longo, blog e monitor ficam desativados por enquanto.
