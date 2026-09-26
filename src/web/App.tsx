import React, { useEffect, useState, type FC } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ProblemDetailsError, type WorkspaceResumo } from "@opencorp/sdk";
import { OpenCorpProvider } from "./providers/OpenCorpProvider.js";
import { useOpenCorp } from "./providers/OpenCorpProvider.js";
import { AppLayout } from "./shared/layout/AppLayout.js";
import { WorkspaceBoundary } from "./shared/layout/WorkspaceBoundary.js";
import { RouteSkeleton } from "./shared/ui/RouteSkeleton.js";
import { AuthGate } from "./shared/auth/AuthGate.js";
import { workspacePath } from "./lib/routes.js";

// Views Nativas em React 19
import { SecretarioView } from "./features/chat/views/SecretarioView.js";
import { TasksView } from "./features/tasks/views/TasksView.js";
import { AgentesView } from "./features/agents/views/AgentesView.js";
import { FluxosView } from "./features/workflows/views/FluxosView.js";
import { WorkspaceView } from "./features/workspace/views/WorkspaceView.js";
import { ConfigView } from "./features/settings/views/ConfigView.js";
import { HomeView } from "./features/home/views/HomeView.js";
import { AppsView } from "./features/apps/views/AppsView.js";
import { ReunioesView } from "./features/meetings/views/ReunioesView.js";
import { HistoricoView } from "./features/history/views/HistoricoView.js";
import { AtivosView } from "./features/assets/views/AtivosView.js";
import { NotificacoesView } from "./features/notifications/views/NotificacoesView.js";
import { DocsView } from "./features/docs/views/DocsView.js";
import { HomeZeroState } from "./features/home/components/HomeZeroState.js";

const ROTAS_LEGADAS: ReadonlyArray<{
  path: string;
  modulo: string;
  queryPadrao?: Record<string, string>;
}> = [
  { path: "/home", modulo: "" },
  { path: "/secretario", modulo: "secretario" },
  { path: "/tasks", modulo: "tasks" },
  { path: "/agentes", modulo: "agentes" },
  { path: "/fluxos", modulo: "fluxos" },
  { path: "/workspace", modulo: "workspace" },
  { path: "/config", modulo: "config" },
  { path: "/apps", modulo: "apps" },
  { path: "/reunioes", modulo: "reunioes" },
  { path: "/historico", modulo: "historico" },
  { path: "/ativos", modulo: "ativos" },
  { path: "/notificacoes", modulo: "notificacoes" },
  { path: "/agenda", modulo: "fluxos", queryPadrao: { filtro: "cron" } },
  { path: "/hooks", modulo: "fluxos" },
  { path: "/secrets", modulo: "config", queryPadrao: { tab: "chaves" } },
];

function lerUltimoWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  const salvo =
    localStorage.getItem("oc-ws") ||
    localStorage.getItem("opencorp_workspace_id");
  return salvo?.trim() || null;
}

function workspaceNaoEncontrado(erro: unknown): boolean {
  return (
    erro instanceof ProblemDetailsError &&
    (erro.status === 404 ||
      (erro.status === 422 && erro.detail?.toLowerCase().includes("workspace") === true &&
        erro.detail.toLowerCase().includes("não encontrado")))
  );
}

const WorkspacesRoute: FC = () => {
  const { client, tratarErro } = useOpenCorp();
  const [workspaces, setWorkspaces] = useState<WorkspaceResumo[]>([]);
  const [carregando, setCarregando] = useState(true);

  const carregar = async () => {
    setCarregando(true);
    try {
      setWorkspaces((await client.workspaces.listar()) ?? []);
    } catch (erro: unknown) {
      tratarErro(erro, "Falha ao listar workspaces");
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
  }, [client]);

  if (carregando) return <RouteSkeleton />;

  return (
    <HomeZeroState
      workspaces={workspaces}
      aoAtualizarWorkspaces={() => void carregar()}
    />
  );
};

const RedirectWorkspace: FC<{
  modulo?: string;
  raiz?: boolean;
  queryPadrao?: Record<string, string>;
}> = ({
  modulo = "",
  raiz = false,
  queryPadrao,
}) => {
  const { client } = useOpenCorp();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const workspaceId = lerUltimoWorkspace();
    if (!workspaceId) {
      const destino = raiz
        ? "/workspaces"
        : `/workspaces?${new URLSearchParams({ next: `${location.pathname}${location.search}` })}`;
      navigate(destino, { replace: true });
      return;
    }

    const controller = new AbortController();
    void client.http
      .get(`/workspaces/${encodeURIComponent(workspaceId)}`, {
        signal: controller.signal,
      })
      .then(() => {
        if (controller.signal.aborted) return;
        const query = new URLSearchParams(location.search);
        for (const [chave, valor] of Object.entries(queryPadrao ?? {})) {
          if (!query.has(chave)) query.set(chave, valor);
        }
        const queryString = query.toString();
        navigate(`${workspacePath(workspaceId, modulo)}${queryString ? `?${queryString}` : ""}`, {
          replace: true,
        });
      })
      .catch((erro: unknown) => {
        if (controller.signal.aborted) return;
        if (workspaceNaoEncontrado(erro)) {
          localStorage.removeItem("oc-ws");
          localStorage.removeItem("opencorp_workspace_id");
        }
        const destino = raiz
          ? "/workspaces"
          : `/workspaces?${new URLSearchParams({ next: `${location.pathname}${location.search}` })}`;
        navigate(destino, { replace: true });
      });

    return () => controller.abort();
  }, [client.http, location.pathname, location.search, modulo, navigate, queryPadrao, raiz]);

  return <RouteSkeleton />;
};

export const App: FC = () => {
  return (
    <BrowserRouter>
      <AuthGate>
      <OpenCorpProvider workspaceId={null}>
        <Routes>
          {/* Rotas globais usam client sem header de workspace e não abrem SSE. */}
          <Route element={<AppLayout />}>
            <Route path="/" element={<RedirectWorkspace raiz />} />
            <Route path="/workspaces" element={<WorkspacesRoute />} />
            <Route path="/config/global" element={<ConfigView />} />
            <Route path="/docs" element={<DocsView />} />

            {/* Compatibilidade: valida o último workspace e preserva a query original. */}
            {ROTAS_LEGADAS.map(({ path, modulo, queryPadrao }) => (
              <Route
                key={path}
                path={path}
                element={<RedirectWorkspace modulo={modulo} queryPadrao={queryPadrao} />}
              />
            ))}

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>

          {/* O boundary monta provider e layout isolados pelo workspace da URL. */}
          <Route path="/w/:workspaceId" element={<WorkspaceBoundary />}>
            <Route index element={<HomeView />} />
            <Route path="workspace" element={<WorkspaceView />} />
            <Route path="tasks" element={<TasksView />} />
            <Route path="secretario" element={<SecretarioView />} />
            <Route path="agentes" element={<AgentesView />} />
            <Route path="fluxos" element={<FluxosView />} />
            <Route path="reunioes" element={<ReunioesView />} />
            <Route path="historico" element={<HistoricoView />} />
            <Route path="apps" element={<AppsView />} />
            <Route path="ativos" element={<AtivosView />} />
            <Route path="notificacoes" element={<NotificacoesView />} />
            <Route path="config" element={<ConfigView />} />
          </Route>
        </Routes>
      </OpenCorpProvider>
      </AuthGate>
    </BrowserRouter>
  );
};
