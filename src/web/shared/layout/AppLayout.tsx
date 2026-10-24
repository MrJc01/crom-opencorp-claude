import React, { Suspense, useState, useEffect, type FC } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";
import { ToastContainer } from "../ui/Toast.js";
import { RouteSkeleton } from "../ui/RouteSkeleton.js";
import { SecretarioDock } from "../../features/chat/components/SecretarioDock.js";
import { Bot } from "lucide-react";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";

export const AppLayout: FC = () => {
  const [dockAberto, setDockAberto] = useState(false);
  const [sidebarMobileAberta, setSidebarMobileAberta] = useState(false);
  const { pathname } = useLocation();
  const { workspaceId } = useOpenCorp();
  // O Secretário pertence a um workspace: sem workspace aberto, nem dock, nem botão, nem Ctrl+J.
  const secretarioDisponivel = Boolean(workspaceId);
  // Na página do Secretário o chat já ocupa a tela: sem dock nem botão flutuante.
  const naPaginaSecretario = /\/secretario\/?$/.test(pathname);

  useEffect(() => {
    setSidebarMobileAberta(false);
  }, [pathname]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Atalho Ctrl+J ou Cmd+J para alternar o dock
      if (secretarioDisponivel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setDockAberto((prev) => !prev);
      }
      // Atalho Esc para fechar o dock caso aberto
      if (e.key === "Escape" && dockAberto) {
        setDockAberto(false);
      }
      if (e.key === "Escape" && sidebarMobileAberta) {
        setSidebarMobileAberta(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dockAberto, sidebarMobileAberta, secretarioDisponivel]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100 antialiased font-sans">
      {/* Sidebar Lateral */}
      <Sidebar
        mobileAberta={sidebarMobileAberta}
        aoFecharMobile={() => setSidebarMobileAberta(false)}
      />

      {/* Área Central de Trabalho */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        <Topbar
          onToggleMenuMobile={() => setSidebarMobileAberta((prev) => !prev)}
          aoAlternarSecretario={() => setDockAberto((prev) => !prev)}
          secretarioAberto={dockAberto}
        />

        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden relative bg-zinc-950">
          <Suspense fallback={<RouteSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Dock Lateral Flutuante do Secretário */}
      {secretarioDisponivel && !naPaginaSecretario && <SecretarioDock aberto={dockAberto} aoFechar={() => setDockAberto(false)} />}
      {secretarioDisponivel && !naPaginaSecretario && !dockAberto && (
        <button
          type="button"
          data-testid="secretario-fab"
          aria-label="Abrir Secretário Executivo"
          title="Abrir Secretário Executivo (Ctrl+J)"
          onClick={() => setDockAberto(true)}
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-700 text-white shadow-lg shadow-emerald-950/60 hover:bg-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <Bot size={20} aria-hidden="true" />
        </button>
      )}

      {/* Container Global de Notificações Toast */}
      <ToastContainer />
    </div>
  );
};
