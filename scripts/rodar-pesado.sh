#!/usr/bin/env bash
# Roda uma tarefa pesada (tsc, vitest, playwright, build) SEM poder travar o PC.
#
# Por quê: em 2026-10-20 o PC travou duas vezes durante testes (o log do boot anterior mostra "Under memory
# pressure" logo antes da queda: 14 GB de RAM e 2 GB de swap, com os canais renderizando vídeo ao mesmo tempo).
#
# O que faz:
#  1. Uma tarefa pesada por vez (trava em /tmp/opencorp-pesado.lock); as outras esperam na fila.
#  2. Recusa começar com pouca memória livre (OPENCORP_PESADO_MEM_MIN_MB, padrão 4500).
#  3. Limita a memória da tarefa (OPENCORP_PESADO_MEM, padrão 5G, sem swap): se estourar, SÓ ELA morre
#     (código 137) e o resto do PC, incluindo os vídeos dos canais, segue.
#  4. Prioridade mínima de CPU e de disco (nice 19, ionice classe 3, CPUWeight baixo).
#
# Uso:  scripts/rodar-pesado.sh npx vitest run
#       scripts/rodar-pesado.sh npx playwright test tests/e2e/x.spec.ts --workers=1
#       scripts/rodar-pesado.sh npm run build
# Nunca rode carga artificial de CPU/memória neste PC.
set -uo pipefail

LIMITE_MEM="${OPENCORP_PESADO_MEM:-5G}"
MEM_MIN_MB="${OPENCORP_PESADO_MEM_MIN_MB:-4500}"
ESPERA_FILA_S="${OPENCORP_PESADO_ESPERA_S:-900}"
LOCK="/tmp/opencorp-pesado.lock"

if [ "$#" -eq 0 ]; then
  echo "uso: $0 <comando> [args...]" >&2
  exit 64
fi

exec 9>"$LOCK"
if ! flock -w "$ESPERA_FILA_S" 9; then
  echo "[rodar-pesado] outra tarefa pesada segue rodando há mais de ${ESPERA_FILA_S}s; desisti de esperar." >&2
  exit 75
fi

disponivel_mb() { awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo; }

# Memória baixa quase sempre é passageira (cache, outra renderização): espera até 5 min antes de recusar.
for _ in $(seq 1 30); do
  [ "$(disponivel_mb)" -ge "$MEM_MIN_MB" ] && break
  echo "[rodar-pesado] memória livre $(disponivel_mb) MB < ${MEM_MIN_MB} MB; aguardando..." >&2
  sleep 10
done
if [ "$(disponivel_mb)" -lt "$MEM_MIN_MB" ]; then
  echo "[rodar-pesado] memória insuficiente ($(disponivel_mb) MB livres, mínimo ${MEM_MIN_MB} MB). Não vou arriscar travar o PC." >&2
  exit 75
fi

echo "[rodar-pesado] limite de memória ${LIMITE_MEM}, prioridade mínima: $*" >&2
if systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 true 2>/dev/null; then
  exec nice -n 19 ionice -c3 systemd-run --user --scope -q \
    -p "MemoryMax=${LIMITE_MEM}" -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- "$@"
fi
echo "[rodar-pesado] AVISO: cgroup de usuário indisponível; rodando só com nice/ionice, SEM limite de memória." >&2
exec nice -n 19 ionice -c3 "$@"
