import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type FC,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Folder,
  ChevronDown,
  Search,
  Plus,
  Check,
  LoaderCircle,
  X,
} from "lucide-react";
import type { WorkspaceResumo } from "@opencorp/sdk";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";
import { workspacePath } from "../../lib/routes.js";
import { useNomeWorkspace } from "./useNomeWorkspace.js";
import { NovoWorkspaceModal } from "../../features/home/components/NovoWorkspaceModal.js";

/**
 * Extrai o módulo e sub-rotas atuais a partir do pathname.
 * Ex:
 *  - "/w/meu-ws/tasks" -> "tasks"
 *  - "/w/meu-ws/fluxos/editor/1" -> "fluxos/editor/1"
 *  - "/w/meu-ws" -> ""
 *  - "/tasks" -> "tasks"
 *  - "/workspaces" -> ""
 */
export function extrairModuloAtual(pathname: string): string {
  const match = /^\/w\/[^/]+(?:\/(.*))?$/.exec(pathname);
  if (match) {
    return match[1] || "";
  }

  const segmento = pathname.replace(/^\/+/, "").split("/")[0] || "";
  const modulosValidos = [
    "workspace",
    "tasks",
    "secretario",
    "agentes",
    "fluxos",
    "reunioes",
    "historico",
    "apps",
    "ativos",
    "notificacoes",
    "config",
  ];
  if (modulosValidos.includes(segmento)) {
    return pathname.replace(/^\/+/, "");
  }
  return "";
}

/**
 * Converte a query string da URL em um dicionário Record<string, string>.
 */
function extrairSearchParams(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(search).forEach((val, key) => {
    params[key] = val;
  });
  return params;
}

export const WorkspaceSwitcher: FC = () => {
  const { workspaceId, client, tratarErro } = useOpenCorp();
  const nomeWorkspace = useNomeWorkspace();
  const location = useLocation();
  const navigate = useNavigate();

  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceResumo[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [modalNovoAberto, setModalNovoAberto] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputBuscaRef = useRef<HTMLInputElement>(null);

  const carregarWorkspaces = useCallback(async () => {
    setCarregando(true);
    try {
      const lista = await client.workspaces.listar();
      setWorkspaces(lista || []);
    } catch (erro: unknown) {
      tratarErro(erro, "Falha ao listar workspaces");
    } finally {
      setCarregando(false);
    }
  }, [client, tratarErro]);

  // Carrega ao montar para resposta instantânea ao abrir
  useEffect(() => {
    void carregarWorkspaces();
  }, [carregarWorkspaces]);

  // Gerencia foco e fechamento ao clicar fora ou pressionar Escape
  useEffect(() => {
    if (!aberto) {
      setBusca("");
      return;
    }

    // Foca o input de busca após renderização do popover
    requestAnimationFrame(() => {
      inputBuscaRef.current?.focus();
    });

    const lidarCliqueFora = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setAberto(false);
      }
    };

    const lidarTecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAberto(false);
      }
    };

    document.addEventListener("mousedown", lidarCliqueFora);
    document.addEventListener("touchstart", lidarCliqueFora);
    document.addEventListener("keydown", lidarTecla);

    return () => {
      document.removeEventListener("mousedown", lidarCliqueFora);
      document.removeEventListener("touchstart", lidarCliqueFora);
      document.removeEventListener("keydown", lidarTecla);
    };
  }, [aberto]);

  const workspacesOrdenados = useMemo(() => {
    return [...workspaces].sort((a, b) => a.id.localeCompare(b.id));
  }, [workspaces]);

  const workspacesFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return workspacesOrdenados;
    return workspacesOrdenados.filter((w) => {
      const idMatch = w.id.toLowerCase().includes(q);
      const pathMatch =
        typeof w.path === "string" && w.path.toLowerCase().includes(q);
      return idMatch || pathMatch;
    });
  }, [busca, workspacesOrdenados]);

  const alternarAberto = () => {
    const proximo = !aberto;
    setAberto(proximo);
    if (proximo) {
      void carregarWorkspaces();
    }
  };

  const trocarWorkspace = (novoWsId: string) => {
    setAberto(false);
    if (novoWsId === workspaceId) return;

    const moduloAtual = extrairModuloAtual(location.pathname);
    const params = extrairSearchParams(location.search);
    const destino = workspacePath(novoWsId, moduloAtual, params);
    navigate(destino);
  };

  return (
    <div ref={containerRef} className="relative inline-block text-left select-none">
      {/* Indicador / Gatilho do Dropdown */}
      <button
        type="button"
        onClick={alternarAberto}
        aria-haspopup="listbox"
        aria-expanded={aberto}
        title="Trocar workspace ou criar novo projeto"
        className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850 text-xs text-zinc-300 font-mono transition-colors cursor-pointer group"
      >
        <Folder
          size={13}
          className="text-emerald-400 group-hover:scale-110 transition-transform shrink-0"
        />
        <span className="font-semibold text-zinc-200 max-w-[140px] sm:max-w-[200px] truncate">
          {nomeWorkspace || "Selecionar workspace"}
        </span>
        <ChevronDown
          size={12}
          className={`text-zinc-500 transition-transform duration-200 shrink-0 ${
            aberto ? "rotate-180 text-zinc-300" : ""
          }`}
        />
      </button>

      {/* Popover / Menu Flutuante */}
      {aberto && (
        <div className="absolute top-full left-0 mt-2 w-72 sm:w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
          {/* Campo de Busca Textual */}
          <div className="p-2 border-b border-zinc-800/80 bg-zinc-900/90">
            <div className="relative flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 focus-within:border-emerald-500/60 transition-colors">
              <Search size={13} className="text-zinc-500 mr-2 shrink-0" />
              <input
                ref={inputBuscaRef}
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar workspace..."
                className="w-full bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none font-sans"
              />
              {busca && (
                <button
                  type="button"
                  onClick={() => setBusca("")}
                  className="p-0.5 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  title="Limpar busca"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Lista de Workspaces Disponíveis */}
          <div
            role="listbox"
            className="max-h-56 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin"
          >
            {carregando && workspaces.length === 0 ? (
              <div className="p-4 flex items-center justify-center gap-2 text-xs text-zinc-400">
                <LoaderCircle size={14} className="animate-spin text-emerald-400" />
                <span>Carregando workspaces...</span>
              </div>
            ) : workspacesFiltrados.length === 0 ? (
              <div className="p-4 text-center text-xs text-zinc-500">
                {busca ? "Nenhum workspace encontrado." : "Nenhum workspace cadastrado."}
              </div>
            ) : (
              workspacesFiltrados.map((ws) => {
                const ativo = ws.id === workspaceId;
                return (
                  <button
                    key={ws.id}
                    type="button"
                    role="option"
                    aria-selected={ativo}
                    onClick={() => trocarWorkspace(ws.id)}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs font-mono text-left transition-colors cursor-pointer group ${
                      ativo
                        ? "bg-emerald-950/50 text-emerald-300 border border-emerald-800/40 font-semibold"
                        : "text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/80 border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder
                        size={13}
                        className={
                          ativo
                            ? "text-emerald-400 shrink-0"
                            : "text-zinc-500 group-hover:text-zinc-400 shrink-0"
                        }
                      />
                      <div className="min-w-0">
                        <span className="truncate block font-semibold">{typeof ws.nome === "string" && ws.nome ? ws.nome : ws.id}</span>
                        {ws.path && (
                          <span className="text-[10px] text-zinc-500 truncate block font-sans">
                            {ws.path}
                          </span>
                        )}
                      </div>
                    </div>
                    {ativo && (
                      <Check size={14} className="text-emerald-400 shrink-0" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Divisor e Botão Fixo no Rodapé: + Novo Workspace */}
          <div className="border-t border-zinc-800 p-1.5 bg-zinc-950/50">
            <button
              type="button"
              onClick={() => {
                setAberto(false);
                setModalNovoAberto(true);
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/40 border border-transparent hover:border-emerald-800/40 transition-all cursor-pointer"
            >
              <Plus size={13} />
              <span>+ Novo Workspace</span>
            </button>
          </div>
        </div>
      )}

      {/* Modal de Criação / Importação de Workspace */}
      <NovoWorkspaceModal
        aberto={modalNovoAberto}
        aoFechar={() => setModalNovoAberto(false)}
        aoWorkspaceCriado={(id) => {
          void carregarWorkspaces();
          trocarWorkspace(id);
        }}
      />
    </div>
  );
};
