#!/usr/bin/env bash
# Compila o app de bandeja e instala atalho no sistema (menu de aplicativos + início automático na sessão).
# Uso: desktop/instalar.sh            (compila e instala)
#      desktop/instalar.sh --sem-autostart
set -euo pipefail
cd "$(dirname "$0")"
RAIZ="$(cd .. && pwd)"
ALVO="${CARGO_TARGET_DIR:-/dev/shm/opencorp-desktop-target}"
CARGO_TARGET_DIR="$ALVO" CARGO_BUILD_JOBS=2 "$RAIZ/scripts/rodar-pesado.sh" cargo build --release

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps" "$HOME/.config/autostart"
install -m 755 "$ALVO/release/opencorp-desktop" "$HOME/.local/bin/opencorp-desktop"
install -m 644 icons/icon.png "$HOME/.local/share/icons/hicolor/512x512/apps/opencorp.png"

cat > "$HOME/.local/share/applications/opencorp.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=OpenCorp
Comment=Empresas autônomas com agentes de IA (bandeja: abrir, pausar, desligar, configurações)
Exec=$HOME/.local/bin/opencorp-desktop
Icon=opencorp
Terminal=false
Categories=Development;Office;
StartupWMClass=opencorp-desktop
Actions=Web;Config;

[Desktop Action Web]
Name=Abrir no navegador
Exec=xdg-open http://127.0.0.1:4100

[Desktop Action Config]
Name=Configurações
Exec=xdg-open http://127.0.0.1:4100/config
DESK

if [ "${1:-}" != "--sem-autostart" ]; then
  sed 's|^Exec=.*opencorp-desktop$|Exec='"$HOME"'/.local/bin/opencorp-desktop --oculto|; /^Actions=/,$d' "$HOME/.local/share/applications/opencorp.desktop" > "$HOME/.config/autostart/opencorp.desktop"
  echo "X-GNOME-Autostart-enabled=true" >> "$HOME/.config/autostart/opencorp.desktop"
fi
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "ok: instalado em ~/.local/bin/opencorp-desktop; atalho 'OpenCorp' no menu de aplicativos"
