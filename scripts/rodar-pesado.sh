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
#  4. Prioridade BAIXA, mas nunca "idle": nice 10, ionice classe 2 nível 7 (melhor esforço, o menor), pesos 50.
#     Em 2026-10-20 a classe idle de I/O (ionice -c3) deixou o servidor de teste sem disco por >20 s enquanto os canais
#     renderizavam vídeo: uma cópia síncrona travou o event loop e o watchdog encerrou o servidor. O que protege o PC é
#     o LIMITE DE MEMÓRIA (item 3), não a prioridade; por isso a prioridade não pode ser a mais baixa possível.
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

# Temporários em RAM: o disco do dono é lento (SSD 87% cheio, ~124 ms por escrita) e os testes criam milhares de
# arquivos pequenos em tmpdir(). Em /dev/shm eles não tocam no disco.
if [ -d /dev/shm ] && [ "$(df -Pm /dev/shm | awk 'NR==2 {print $4}')" -gt 1500 ]; then
  export TMPDIR="/dev/shm/opencorp-tmp-$$"
  mkdir -p "$TMPDIR"
  trap 'rm -rf "$TMPDIR"' EXIT
fi
echo "[rodar-pesado] limite de memória ${LIMITE_MEM}, prioridade baixa, temporários em ${TMPDIR:-/tmp}: $*" >&2
if systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 true 2>/dev/null; then
  nice -n 10 ionice -c2 -n7 systemd-run --user --scope -q \
    -p "MemoryMax=${LIMITE_MEM}" -p MemorySwapMax=0 -p CPUWeight=50 -p IOWeight=50 \
    -p "IOWriteBandwidthMax=/dev/sda ${OPENCORP_PESADO_ESCRITA_MAX:-10M}" -- "$@"
  exit $?
fi
echo "[rodar-pesado] AVISO: cgroup de usuário indisponível; rodando só com nice/ionice, SEM limite de memória." >&2
nice -n 10 ionice -c2 -n7 "$@"
exit $?
