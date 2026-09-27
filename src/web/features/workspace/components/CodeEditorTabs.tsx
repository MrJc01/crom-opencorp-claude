import React, { useEffect, useMemo, type FC } from "react";
import {
  FileCode,
  Eye,
  Columns,
  Save,
  X,
  Copy,
  Download,
  Video,
  Image as ImageIcon,
  Music,
  FileText,
  Workflow,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { renderDocMarkdown } from "../../../lib/doc-renderer.js";
import { showToast } from "../../../shared/ui/Toast.js";

export interface TabArquivo {
  caminho: string;
  nome: string;
  original: string;
  editado: string;
  modo: "editor" | "preview" | "split" | "media";
  binario?: boolean;
  rawUrl?: string;
  tamanho?: number;
  mime?: string;
  tipoMidia?: "video" | "imagem" | "audio" | "outro";
  workspace?: string;
}

export interface CodeEditorTabsProps {
  tabs: TabArquivo[];
  tabAtiva: string | null;
  aoMudarTabAtiva: (caminho: string) => void;
  aoFecharTab: (caminho: string) => void;
  aoAtualizarConteudo: (caminho: string, novoConteudo: string) => void;
  aoMudarModoTab: (caminho: string, modo: "editor" | "preview" | "split" | "media") => void;
  aoSalvarTab: (tab: TabArquivo) => Promise<void>;
  salvando: boolean;
  aoAbrirArquivo?: (caminho: string) => void;
  arquivosDisponiveis?: string[];
}

function formatarBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function obterIconeTab(tab: TabArquivo) {
  if (tab.tipoMidia === "video") return <Video size={13} className="text-rose-400 shrink-0" />;
  if (tab.tipoMidia === "imagem") return <ImageIcon size={13} className="text-emerald-400 shrink-0" />;
  if (tab.tipoMidia === "audio") return <Music size={13} className="text-purple-400 shrink-0" />;
  if (tab.caminho.endsWith(".json") || tab.caminho.endsWith(".ts") || tab.caminho.endsWith(".tsx")) {
    return <FileCode size={13} className="text-amber-400 shrink-0" />;
  }
  return <FileText size={13} className="text-blue-400 shrink-0" />;
}

export const CodeEditorTabs: FC<CodeEditorTabsProps> = ({
  tabs,
  tabAtiva,
  aoMudarTabAtiva,
  aoFecharTab,
  aoAtualizarConteudo,
  aoMudarModoTab,
  aoSalvarTab,
  salvando,
  aoAbrirArquivo,
  arquivosDisponiveis,
}) => {
  const tabAtual = useMemo(() => tabs.find((t) => t.caminho === tabAtiva) ?? null, [tabs, tabAtiva]);

  // Atalho global Ctrl+S para salvar tab ativa
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (tabAtual && !tabAtual.binario) {
          e.preventDefault();
          void aoSalvarTab(tabAtual);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabAtual, aoSalvarTab]);

  const copiarCaminho = (caminho: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(caminho);
      showToast(`Caminho "${caminho}" copiado!`, "sucesso");
    }
  };

  // Salva arquivos abertos recentemente no localStorage
  useEffect(() => {
    if (tabAtiva) {
      try {
        const raw = localStorage.getItem("oc-recentes-workspace");
        const salvos = raw ? (JSON.parse(raw) as string[]) : [];
        const filtrados = [tabAtiva, ...salvos.filter((c) => c !== tabAtiva)].slice(0, 8);
        localStorage.setItem("oc-recentes-workspace", JSON.stringify(filtrados));
      } catch {}
    }
  }, [tabAtiva]);

  // Lista de arquivos sugeridos (recentes do localStorage filtrados ou arquivos reais disponíveis na árvore)
  const arquivosSugeridos = useMemo(() => {
    try {
      const raw = localStorage.getItem("oc-recentes-workspace");
      if (raw) {
        const lista = JSON.parse(raw) as string[];
        if (Array.isArray(lista) && lista.length > 0) {
          // Se tivermos arquivosDisponiveis, garante que os arquivos recentes ainda existem no workspace
          if (arquivosDisponiveis && arquivosDisponiveis.length > 0) {
            const validos = lista.filter((c) => arquivosDisponiveis.includes(c));
            if (validos.length > 0) {
              return validos.slice(0, 8);
            }
          } else {
            return lista.slice(0, 8);
          }
        }
      }
    } catch {}

    // Sem recentes salvos, utiliza os primeiros arquivos disponíveis reais do workspace
    if (arquivosDisponiveis && arquivosDisponiveis.length > 0) {
      return arquivosDisponiveis.slice(0, 8);
    }

    return [];
  }, [tabAtiva, tabs, arquivosDisponiveis]);

  // Se nenhuma tab estiver aberta, exibe a tela de boas-vindas do Workspace
  if (!tabAtual || tabs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full p-8 text-center space-y-4 bg-zinc-950 select-none overflow-y-auto">
        <div className="h-14 w-14 rounded-2xl bg-emerald-950/50 border border-emerald-800/40 flex items-center justify-center text-emerald-400 shadow-xl shadow-emerald-950/20">
          <FileCode size={26} />
        </div>

        <div className="max-w-md space-y-1.5">
          <h3 className="text-base font-bold text-zinc-100">
            IDE Workspace Aberto
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Selecione qualquer arquivo do projeto na árvore à esquerda para editar, visualizar Markdown ou inspecionar mídias geradas.
          </p>
        </div>

        {/* Sugestões de Acesso Rápido Dinâmicas ou Empty State */}
        {arquivosSugeridos.length > 0 ? (
          <div className="pt-2 flex flex-col items-center gap-2 max-w-lg">
            <span className="text-[11px] font-mono text-zinc-500 uppercase tracking-wider">
              Arquivos Recentes &amp; Atalhos do Workspace
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {aoAbrirArquivo &&
                arquivosSugeridos.map((caminho) => {
                  const nome = caminho.split("/").pop() || caminho;
                  const isFlow = caminho.includes("/flows/") || caminho.endsWith("-flow.json");
                  const isMarkdown = caminho.endsWith(".md");
                  const isJson = caminho.endsWith(".json");

                  const Icone = isFlow
                    ? Workflow
                    : isMarkdown
                    ? FileText
                    : isJson
                    ? FileCode
                    : FileCode;

                  const corIcone = isFlow
                    ? "text-emerald-400"
                    : isMarkdown
                    ? "text-purple-400"
                    : isJson
                    ? "text-amber-400"
                    : "text-blue-400";

                  return (
                    <button
                      key={caminho}
                      type="button"
                      onClick={() => aoAbrirArquivo(caminho)}
                      title={`Abrir ${caminho}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 text-xs text-zinc-300 font-mono transition-colors cursor-pointer group"
                    >
                      <Icone size={13} className={corIcone} />
                      <span className="group-hover:text-zinc-100">{nome}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        ) : (
          <div className="pt-2 flex flex-col items-center gap-1.5 max-w-sm text-center">
            <span className="text-xs text-zinc-500">
              Nenhum arquivo recente ou disponível no workspace.
            </span>
            <p className="text-[11px] text-zinc-600">
              Crie um novo arquivo ou pasta utilizando os botões de ação na árvore de arquivos à esquerda.
            </p>
          </div>
        )}
      </div>
    );
  }

  const temAlteracoes = tabAtual.editado !== tabAtual.original;
  const ehMarkdown = tabAtual.caminho.toLowerCase().endsWith(".md");

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-zinc-950 overflow-hidden select-none">
      {/* ─────────────────────────────────────────────────────────────
          1. BARRA SUPERIOR DE ABAS (TABS MULTI-ARQUIVOS ESTILO VS CODE)
         ───────────────────────────────────────────────────────────── */}
      <div className="h-9 border-b border-zinc-850 bg-zinc-900/40 flex items-center justify-between px-2 overflow-x-auto scrollbar-none shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none h-full py-1">
          {tabs.map((tab) => {
            const ativa = tab.caminho === tabAtiva;
            const dirty = tab.editado !== tab.original;
            return (
              <div
                key={tab.caminho}
                onClick={() => aoMudarTabAtiva(tab.caminho)}
                className={`group flex items-center gap-2 px-3 py-1 rounded-md text-xs font-mono cursor-pointer transition-all border shrink-0 ${
                  ativa
                    ? "bg-zinc-800/90 text-zinc-100 font-semibold border-zinc-700/60 shadow-xs"
                    : "bg-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850/60 border-transparent"
                }`}
                title={tab.caminho}
              >
                {obterIconeTab(tab)}
                <span className="truncate max-w-[140px] sm:max-w-[200px]">{tab.nome}</span>

                {/* Indicador de Alteração Não Salva */}
                {dirty && (
                  <span
                    className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0"
                    title="Alterações não salvas"
                    role="img"
                    aria-label="Alterações não salvas"
                  />
                )}

                {/* Botão de Fechar Aba */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    aoFecharTab(tab.caminho);
                  }}
                  className="opacity-60 group-hover:opacity-100 hover:text-rose-400 p-0.5 rounded transition-opacity"
                  title="Fechar aba"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          2. BARRA DE CONTROLE DA TAB ATIVA (AÇÕES, MODOS E SALVAR)
         ───────────────────────────────────────────────────────────── */}
      <div className="h-10 border-b border-zinc-850/80 px-4 flex items-center justify-between bg-zinc-900/30 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0 font-mono text-zinc-400">
          <span className="text-zinc-200 font-semibold truncate">{tabAtual.nome}</span>
          <span className="text-zinc-600 truncate hidden md:inline">({tabAtual.caminho})</span>
          <button
            type="button"
            onClick={() => copiarCaminho(tabAtual.caminho)}
            className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Copiar caminho relativo"
          >
            <Copy size={12} />
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Alternador de Modo de Visualização (Código, Preview, Split) */}
          {!tabAtual.binario && (
            <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
              <button
                type="button"
                onClick={() => aoMudarModoTab(tabAtual.caminho, "editor")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  tabAtual.modo === "editor"
                    ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
                title="Visualização em Código Puro"
              >
                <FileCode size={12} />
                <span>Código</span>
              </button>

              <button
                type="button"
                onClick={() => aoMudarModoTab(tabAtual.caminho, "preview")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  tabAtual.modo === "preview"
                    ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
                title="Preview Renderizado Markdown"
              >
                <Eye size={12} />
                <span>Preview</span>
              </button>

              <button
                type="button"
                onClick={() => aoMudarModoTab(tabAtual.caminho, "split")}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  tabAtual.modo === "split"
                    ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
                title="Tela Dividida (Código + Preview)"
              >
                <Columns size={12} />
                <span>Split</span>
              </button>
            </div>
          )}

          {/* Botão de Salvar */}
          {!tabAtual.binario && (
            <button
              type="button"
              onClick={() => void aoSalvarTab(tabAtual)}
              disabled={salvando || !temAlteracoes}
              className="flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs transition-all cursor-pointer"
              title="Salvar alterações (Ctrl+S)"
            >
              <Save size={13} />
              <span>{salvando ? "Salvando..." : temAlteracoes ? "Salvar *" : "Salvo"}</span>
            </button>
          )}

          {/* Botão de Download para Mídias ou Arquivos Binários */}
          {tabAtual.rawUrl && (
            <a
              href={tabAtual.rawUrl}
              download={tabAtual.nome}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors"
              title="Baixar arquivo original"
            >
              <Download size={13} />
              <span className="hidden sm:inline">Baixar</span>
            </a>
          )}
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          3. ÁREA PRINCIPAL DO EDITOR / PREVIEW / MEDIA PLAYER
         ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* Caso A: Mídia - Vídeo */}
        {tabAtual.tipoMidia === "video" && (
          <div className="flex flex-col items-center justify-start h-full w-full p-4 sm:p-6 bg-zinc-950/90 overflow-y-auto">
            <div className="w-full max-w-3xl flex flex-col items-center bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 shadow-2xl backdrop-blur-md">
              <div className="w-full flex items-center justify-between pb-3.5 mb-4 border-b border-zinc-800/80">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
                    <Video size={18} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-zinc-100 truncate">{tabAtual.nome}</h3>
                    <p className="text-[11px] text-zinc-400 font-mono truncate">{tabAtual.caminho}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                    {tabAtual.mime || "Vídeo"}
                  </span>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-mono bg-zinc-800 text-zinc-300">
                    {formatarBytes(tabAtual.tamanho)}
                  </span>
                </div>
              </div>

              <div className="relative flex items-center justify-center bg-black/90 rounded-xl overflow-hidden border border-zinc-800 shadow-2xl w-full max-h-[60vh] py-2">
                <video
                  src={tabAtual.rawUrl}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[58vh] max-w-full rounded-lg shadow-inner object-contain focus:outline-none"
                >
                  Seu navegador não suporta reprodução deste vídeo.
                </video>
              </div>

              {/* Pacote da Produção (Atalhos se estiver em exports/videos/) */}
              {tabAtual.caminho.includes("exports/videos/") && aoAbrirArquivo && (
                <div className="w-full mt-4 pt-3.5 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-zinc-400 text-[11px] font-medium flex items-center gap-1.5">
                    <Sparkles size={13} className="text-amber-400" />
                    Arquivos do Pacote de Produção:
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const pasta = tabAtual.caminho.substring(0, tabAtual.caminho.lastIndexOf("/"));
                        aoAbrirArquivo(`${pasta}/roteiro.json`);
                      }}
                      className="px-2.5 py-1 rounded text-[11px] bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 font-mono transition-colors cursor-pointer"
                    >
                      roteiro.json
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const pasta = tabAtual.caminho.substring(0, tabAtual.caminho.lastIndexOf("/"));
                        aoAbrirArquivo(`${pasta}/legendas.srt`);
                      }}
                      className="px-2.5 py-1 rounded text-[11px] bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 font-mono transition-colors cursor-pointer"
                    >
                      legendas.srt
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const pasta = tabAtual.caminho.substring(0, tabAtual.caminho.lastIndexOf("/"));
                        aoAbrirArquivo(`${pasta}/metadados_publicacao.json`);
                      }}
                      className="px-2.5 py-1 rounded text-[11px] bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 font-mono transition-colors cursor-pointer"
                    >
                      metadados_publicacao.json
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Caso B: Mídia - Imagem */}
        {tabAtual.tipoMidia === "imagem" && (
          <div className="flex flex-col items-center justify-start h-full w-full p-4 sm:p-8 bg-zinc-950/90 overflow-y-auto">
            <div className="w-full max-w-4xl flex flex-col items-center bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 shadow-2xl backdrop-blur-md">
              <div className="w-full flex items-center justify-between pb-3.5 mb-4 border-b border-zinc-800/80">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    <ImageIcon size={18} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-zinc-100 truncate">{tabAtual.nome}</h3>
                    <p className="text-[11px] text-zinc-400 font-mono truncate">{tabAtual.caminho}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30">
                    {tabAtual.mime || "Imagem"}
                  </span>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-mono bg-zinc-800 text-zinc-300">
                    {formatarBytes(tabAtual.tamanho)}
                  </span>
                </div>
              </div>
              <div className="relative flex items-center justify-center bg-zinc-950/90 rounded-xl p-3 overflow-hidden border border-zinc-800 shadow-2xl max-h-[65vh] w-full">
                <img
                  src={tabAtual.rawUrl}
                  alt={tabAtual.nome}
                  className="max-h-[60vh] max-w-full object-contain rounded shadow"
                />
              </div>
            </div>
          </div>
        )}

        {/* Caso C: Mídia - Áudio */}
        {tabAtual.tipoMidia === "audio" && (
          <div className="flex flex-col items-center justify-center h-full w-full p-6 bg-zinc-950 overflow-y-auto">
            <div className="w-full max-w-md flex flex-col items-center bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 shadow-2xl">
              <div className="p-3 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 mb-3">
                <Music size={24} />
              </div>
              <h3 className="text-sm font-bold text-zinc-100 truncate max-w-full mb-1">{tabAtual.nome}</h3>
              <span className="text-xs text-zinc-400 font-mono mb-4">{formatarBytes(tabAtual.tamanho)}</span>
              <audio controls src={tabAtual.rawUrl} className="w-full" />
            </div>
          </div>
        )}

        {/* Caso D: Arquivo Binário Geral */}
        {tabAtual.binario && tabAtual.tipoMidia !== "video" && tabAtual.tipoMidia !== "imagem" && tabAtual.tipoMidia !== "audio" && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 space-y-3 p-6 bg-zinc-950">
            <FileCode size={36} className="text-zinc-600" />
            <p className="text-xs">Arquivo binário ({tabAtual.mime || "desconhecido"}).</p>
            {tabAtual.rawUrl && (
              <a
                href={tabAtual.rawUrl}
                download={tabAtual.nome}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                <Download size={13} />
                Baixar Arquivo
              </a>
            )}
          </div>
        )}

        {/* Caso E: Arquivo de Texto - Modo Código */}
        {!tabAtual.binario && tabAtual.modo === "editor" && (
          <div className="h-full w-full flex flex-col p-2 bg-zinc-950">
            <textarea
              value={tabAtual.editado}
              onChange={(e) => aoAtualizarConteudo(tabAtual.caminho, e.target.value)}
              spellCheck={false}
              className="flex-1 w-full p-4 bg-zinc-950 font-mono text-xs text-zinc-200 resize-none focus:outline-none border-none leading-relaxed select-text"
              placeholder="Arquivo vazio..."
            />
          </div>
        )}

        {/* Caso F: Arquivo de Texto - Modo Preview Markdown */}
        {!tabAtual.binario && tabAtual.modo === "preview" && (
          <div className="h-full w-full overflow-y-auto p-6 bg-zinc-950 select-text">
            <div
              className="max-w-4xl mx-auto prose prose-invert prose-sm text-zinc-300 leading-relaxed font-sans"
              dangerouslySetInnerHTML={{ __html: renderDocMarkdown(tabAtual.editado) }}
            />
          </div>
        )}

        {/* Caso G: Arquivo de Texto - Modo Split Screen */}
        {!tabAtual.binario && tabAtual.modo === "split" && (
          <div className="h-full w-full flex divide-x divide-zinc-850 bg-zinc-950">
            {/* Lado Esquerdo: Editor */}
            <div className="w-1/2 h-full flex flex-col p-2">
              <textarea
                value={tabAtual.editado}
                onChange={(e) => aoAtualizarConteudo(tabAtual.caminho, e.target.value)}
                spellCheck={false}
                className="flex-1 w-full p-4 bg-zinc-950 font-mono text-xs text-zinc-200 resize-none focus:outline-none border-none leading-relaxed select-text"
                placeholder="Arquivo vazio..."
              />
            </div>

            {/* Lado Direito: Preview Renderizado */}
            <div className="w-1/2 h-full overflow-y-auto p-6 select-text">
              <div
                className="max-w-full prose prose-invert prose-sm text-zinc-300 leading-relaxed font-sans"
                dangerouslySetInnerHTML={{ __html: renderDocMarkdown(tabAtual.editado) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
