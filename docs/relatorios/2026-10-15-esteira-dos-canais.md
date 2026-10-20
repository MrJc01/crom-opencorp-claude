# Relatório da esteira dos canais — 15/10/2026

## Resumo

Os dois canais produziram e publicaram sozinhos o dia inteiro. Só foi ao ar vídeo aprovado pelo revisor.
Nesta revisão do funcionamento cortei o gasto de cada agente pela metade ou mais, sem mexer na qualidade.

## Números do dia (vídeos feitos no visual novo, com Remotion)

| Canal | Produzidos | Aprovados e no YouTube | Reprovados (refeitos ou encerrados) | Esperando revisão |
|---|---|---|---|---|
| Bit Proibido | 27 (inclui o boletim) | 19 | 6 | 2 |
| Fundão | 22 | 13 | 5 | 4 |

- Cerca de 160 execuções de agente. Cada uma levou de meio minuto a 2 minutos.
- Falhas de hoje: 13 pelo **limite de uso do Claude** (madrugada, das 4h às 7h) e 5 interrompidas quando reiniciei o
  sistema. Nenhuma falha de lógica. As etapas voltaram sozinhas.
- O checador descartou uma pauta por expor um menor de idade (Halle Berry). O revisor reprovou vídeos com foto errada
  (Tate McRae no lugar da Gypsy Rose) e com título que não batia com a checagem. A esteira refez e os novos passaram.

## O que melhorei agora (economia e facilidade para os agentes)

1. **Prompt de cada agente 66% menor** (de 12,8 mil para 4,4 mil caracteres por execução).
   O opencorp anexava a todo agente um "contexto" pensado para outro motor: tarefas antigas do Kanban, um site errado
   (`hn.algolia.com`), a lista de todos os scripts, um roteiro velho de setembro e a ordem de usar uma ferramenta
   `notificar` que não existe aqui. Isso gastava tokens e confundia. Agora cada agente recebe só o papel dele, a skill
   dele e o `CLAUDE.md` do canal.

2. **Pautador e checador não leem mais o arquivo de pautas inteiro.** No Bit Proibido o `pautas.json` tem 141 KB
   (uns 35 mil tokens), e o pautador o lia toda hora só para não repetir tema. Criei `scripts/pauta.mjs`:
   - `node scripts/pauta.mjs titulos 150` mostra só os títulos já usados;
   - `node scripts/pauta.mjs ver <id>` mostra só a pauta da vez;
   - `node scripts/pauta.mjs nova '<json>'` grava a pauta nova e já dá o número certo.
   As ordens do pautador, a ordem do roteirista no fluxo e as skills de checagem, curadoria e roteiro passaram a usar esses comandos.

3. **Pauta reprovada já pede outra.** Quando uma pauta cai na checagem ou na revisão, ou a fila esvazia, o pautador é
   acionado na hora, sem esperar a rodada de hora em hora.

## Como está rodando

- **Serviço do sistema** `opencorp-daemon` aponta para o opencorp-claude, sobe no boot sem login e reinicia se cair.
- **Publicação:** 1 vídeo aprovado por hora cheia em cada canal, pela API oficial do YouTube. Boletim às 13:00.
  A cota oficial é de 100 envios por dia no projeto `bitproibido-upload`, dividida entre os dois canais (até 45 cada).
- **Pautador:** de hora em hora, até 8 pautas em estoque.
- **Modelo:** todos os agentes usam Claude Haiku 5.5 (o mais leve no limite do plano Pro).
- **Ciclo de saúde:** a cada 2 h avisa no Kanban pauta parada há mais de 3 h e grava o resumo da semana em
  `registries/evolucoes/qualidade-<semana>.md` de cada canal.

## O que ainda pode deixar um horário sem vídeo

- **Limite do plano do Claude** (o mesmo login que você usa aqui): quando estoura, os agentes param algumas horas.
- **Pauta difícil de ilustrar ou com fonte fraca:** vira reprovação e a esteira busca outra, mas isso leva um tempo.
- PC desligado ou sem internet.

Nada disso coloca vídeo ruim no ar: sem revisão aprovada, nada sobe.

## Sugestões para depois (não fiz)

- Se o limite do Claude continuar estourando, dá para reduzir a frequência do pautador à noite (menos vídeos entre
  0h e 7h, quando há menos público) e concentrar a produção de dia.
- Vídeos antigos ruins estão **privados** no YouTube. Apagar de vez só pelo YouTube Studio, se você quiser.

## Onde está tudo

- Sistema: `/home/j/Documentos/GitHub/opencorp-claude` (notas técnicas no `CLAUDE.md`).
- Bit Proibido: `/home/j/.opencorp/workspaces/yt-factory-01`.
- Fundão: `/home/j/.opencorp/workspaces/fundao`.
- Visual dos vídeos (Remotion): `/home/j/.opencorp/remotion-shorts`.
- Testes do sistema: 1545 passando.
