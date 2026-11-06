// App de bandeja do OpenCorp. A janela mostra a UI web servida pelo daemon local (porta 4100);
// o menu da bandeja controla o daemon (systemd do usuário) e a pausa dos workspaces pela API.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const BASE: &str = "http://127.0.0.1:4100";
const SERVICO: &str = "opencorp-daemon";

fn api_get(caminho: &str) -> Option<serde_json::Value> {
    ureq::get(&format!("{BASE}{caminho}"))
        .timeout(Duration::from_secs(3))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn servidor_no_ar() -> bool {
    ureq::get(&format!("{BASE}/workspaces")).timeout(Duration::from_secs(2)).call().is_ok()
}

fn systemctl(acao: &str) {
    let _ = Command::new("systemctl").args(["--user", acao, SERVICO]).status();
}

fn garantir_servidor() {
    if servidor_no_ar() {
        return;
    }
    systemctl("start");
    for _ in 0..40 {
        if servidor_no_ar() {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Pausa ou retoma todos os workspaces (o agendador deixa de disparar fluxos; nada é apagado).
fn pausar_todos(pausado: bool) {
    let Some(lista) = api_get("/workspaces") else { return };
    for ws in lista.as_array().cloned().unwrap_or_default() {
        if let Some(id) = ws.get("id").and_then(|v| v.as_str()) {
            let _ = ureq::post(&format!("{BASE}/workspaces/{id}/pausa"))
                .timeout(Duration::from_secs(5))
                .send_json(serde_json::json!({ "pausado": pausado }));
        }
    }
}

fn resumo_status() -> String {
    if !servidor_no_ar() {
        return "Daemon: desligado".into();
    }
    let lista = api_get("/workspaces").and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let pausados = lista.iter().filter(|w| w.get("pausado").and_then(|p| p.as_bool()) == Some(true)).count();
    if !lista.is_empty() && pausados == lista.len() {
        format!("Daemon: ativo · tudo pausado ({} workspaces)", lista.len())
    } else {
        format!("Daemon: ativo · {} workspaces, {} pausado(s)", lista.len(), pausados)
    }
}

fn abrir(app: &AppHandle, rota: &str) {
    let app = app.clone();
    let rota = rota.to_string();
    std::thread::spawn(move || {
        garantir_servidor();
        let url: tauri::Url = format!("{BASE}{rota}").parse().expect("url");
        if let Some(janela) = app.get_webview_window("main") {
            let _ = janela.navigate(url);
            let _ = janela.show();
            let _ = janela.unminimize();
            let _ = janela.set_focus();
        } else {
            let icone = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).ok();
            let mut b = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(url))
                .title("OpenCorp")
                .inner_size(1280.0, 840.0);
            if let Some(i) = icone {
                b = match b.icon(i) {
                    Ok(x) => x,
                    Err(_) => return,
                };
            }
            let _ = b.build();
        }
    });
}

static CONTADOR_JANELAS: AtomicUsize = AtomicUsize::new(1);

/// Abre mais uma janela independente (cada uma com sua própria navegação).
fn nova_janela(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        garantir_servidor();
        let n = CONTADOR_JANELAS.fetch_add(1, Ordering::SeqCst) + 1;
        let url: tauri::Url = format!("{BASE}/").parse().expect("url");
        let b = WebviewWindowBuilder::new(&app, format!("janela-{n}"), WebviewUrl::External(url))
            .title(format!("OpenCorp ({n})"))
            .inner_size(1280.0, 840.0);
        let _ = b.build();
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| abrir(app, "/")))
        .setup(|app| {
            let status = MenuItemBuilder::with_id("status", "Daemon: verificando…").enabled(false).build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&status)
                .separator()
                .text("abrir", "Abrir OpenCorp")
                .text("nova", "Nova janela")
                .text("navegador", "Abrir no navegador")
                .text("config", "Configurações")
                .separator()
                .text("pausar", "Pausar tudo")
                .text("retomar", "Retomar tudo")
                .separator()
                .text("iniciar", "Iniciar daemon")
                .text("reiniciar", "Reiniciar daemon")
                .text("desligar", "Desligar daemon")
                .separator()
                .text("sair", "Sair do app")
                .build()?;

            let icone = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            TrayIconBuilder::with_id("opencorp")
                .icon(icone)
                .tooltip("OpenCorp")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "abrir" => abrir(app, "/"),
                    "nova" => nova_janela(app),
                    "config" => abrir(app, "/config"),
                    "navegador" => {
                        let _ = Command::new("xdg-open").arg(BASE).spawn();
                    }
                    "pausar" => {
                        std::thread::spawn(|| pausar_todos(true));
                    }
                    "retomar" => {
                        std::thread::spawn(|| pausar_todos(false));
                    }
                    "iniciar" => {
                        std::thread::spawn(|| systemctl("start"));
                    }
                    "reiniciar" => {
                        std::thread::spawn(|| systemctl("restart"));
                    }
                    "desligar" => {
                        std::thread::spawn(|| systemctl("stop"));
                    }
                    "sair" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        abrir(tray.app_handle(), "/");
                    }
                })
                .build(app)?;

            // Atualiza a linha de status a cada 10 s.
            std::thread::spawn(move || loop {
                let _ = status.set_text(resumo_status());
                std::thread::sleep(Duration::from_secs(10));
            });
            // Se o app foi aberto pelo atalho (sem --oculto), mostra a janela já na partida.
            if !std::env::args().any(|a| a == "--oculto") {
                abrir(app.handle(), "/");
            }
            Ok(())
        })
        .on_window_event(|janela, ev| {
            // Fechar a janela só esconde: o app continua na bandeja.
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                // Só a janela principal fica escondida; as extras fecham de verdade.
                if janela.label() == "main" {
                    api.prevent_close();
                    let _ = janela.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao montar o app")
        .run(|_app, ev| {
            // Sem janelas abertas o app não sai: a bandeja segue viva.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = ev {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
