#!/usr/bin/env bash
# Roda o E2E (Playwright) inteiramente em MEMÓRIA, sem castigar o disco do dono.
#
# Por quê: em 2026-10-20 o E2E criava milhares de arquivos pequenos em /tmp (disco do sistema: 87% cheio e com ~124 ms
# de espera por escrita) e a pressão de I/O do PC foi a 85%: tudo travava, e o servidor de teste ficou sem disco por 21 s
# e foi encerrado pelo watchdog. Em /dev/shm (RAM) o E2E não toca no disco.
#
# Uso:  scripts/e2e-seguro.sh [argumentos do playwright]     (ex.: scripts/e2e-seguro.sh tests/e2e/chat.spec.ts)
# Sempre via scripts/rodar-pesado.sh (uma tarefa pesada por vez, com limite de memória).
set -uo pipefail
cd "$(dirname "$0")/.."

RAIZ=/dev/shm
LIVRE_MB=$(df -Pm "$RAIZ" | awk 'NR==2 {print $4}')
if [ "${LIVRE_MB:-0}" -lt 1500 ]; then
  echo "[e2e-seguro] /dev/shm com pouco espaço (${LIVRE_MB} MB). Abortando." >&2
  exit 75
fi

# Servidor órfão de uma rodada anterior na porta 4399 (por PID, nunca pkill -f).
ORFAO=$(ss -ltnp 2>/dev/null | awk '/:4399 / {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
[ -n "$ORFAO" ] && kill "$ORFAO" 2>/dev/null

rm -rf "$RAIZ/opencorp-e2e" "$RAIZ/e2e-home" "$RAIZ/e2e-tmp"
mkdir -p "$RAIZ/e2e-home" "$RAIZ/e2e-tmp"
trap 'rm -rf "$RAIZ/opencorp-e2e" "$RAIZ/e2e-home" "$RAIZ/e2e-tmp"' EXIT

export HOME="$RAIZ/e2e-home" TMPDIR="$RAIZ/e2e-tmp"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/j/.cache/ms-playwright}"
scripts/rodar-pesado.sh npx playwright test --reporter=line "$@"
