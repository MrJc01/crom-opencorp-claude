import React, { useState, useEffect, type FC } from "react";
import { type AgentResumo, type SkillResumo } from "@opencorp/sdk";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import { MODELOS_DISPONIVEIS } from "../constants.js";
import { useMotoresCatalogo } from "../../../lib/engines/catalogo-motores.js";
import { ModelPicker } from "../../../shared/ui/ModelPicker.js";
import {
  X,
  Trash2,
  Save,
  Bot,
  Sliders,
  Shield,
  Cpu,
  Terminal,
  Puzzle,
  FileCode,
  Loader2,
  RotateCcw,
} from "lucide-react";

export interface AgentInspectDrawerProps {
  agente: AgentResumo | null;
  aoFechar: () => void;
  aoSalvar: (agenteAtualizado: AgentResumo) => Promise<void>;
  aoExcluir: (id: string) => Promise<void>;
}

export const AgentInspectDrawer: FC<AgentInspectDrawerProps> = ({
  agente,
  aoFechar,
  aoSalvar,
  aoExcluir,
}) => {
  const { client, tratarErro } = useOpenCorp();
  const motoresCatalogo = useMotoresCatalogo();

  const [role, setRole] = useState("");
  const [modelSelect, setModelSelect] = useState("");
  const [harness, setHarness] = useState("");
  const [rotation, setRotation] = useState<string[]>([]);
  const [workspaceRotationFallback, setWorkspaceRotationFallback] = useState(true);
  const [permissions, setPermissions] = useState<"level-1" | "level-2" | "level-3">("level-2");
  const [prompt, setPrompt] = useState("");
  const [ativo, setAtivo] = useState(true);

  // Skills
  const [skillsSelecionadas, setSkillsSelecionadas] = useState<string[]>([]);
  const [skillsDisponiveis, setSkillsDisponiveis] = useState<SkillResumo[]>([]);
  const [carregandoSkills, setCarregandoSkills] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!agente) return;

    setRole(agente.role || agente.descricao || "");
    const modeloAtual = agente.modelo || agente.model || "";
    setModelSelect(modeloAtual || MODELOS_DISPONIVEIS[0]?.id || "");

    setHarness(agente.harness || "opencode");
    setRotation(agente.rotation || []);
    setWorkspaceRotationFallback(agente.workspace_rotation_fallback !== false);
    setPermissions(agente.permissions || "level-2");
    setPrompt(agente.system_prompt || agente.corpo_prompt || agente.corpo || "");
    setAtivo(agente.ativo !== false && agente.active !== false);
    setSkillsSelecionadas(agente.skills || []);

    // Carrega skills instaladas no workspace
    void (async () => {
      setCarregandoSkills(true);
      try {
        const skills = await client.agents.listarSkills().catch(() => []);
        setSkillsDisponiveis(skills || []);
      } catch {
        setSkillsDisponiveis([]);
      } finally {
        setCarregandoSkills(false);
      }
    })();
  }, [agente, client.agents]);

  if (!agente) return null;

  const handleSalvar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);

    try {
      const payload: Partial<AgentResumo> = {
        role: role.trim() || undefined,
        model: modelSelect || undefined,
        harness: harness || undefined,
        rotation: rotation.length > 0 ? rotation : undefined,
        workspace_rotation_fallback: workspaceRotationFallback,
        permissions,
        corpo_prompt: prompt,
        ativo,
        skills: skillsSelecionadas,
      };

      await aoSalvar({ ...agente, ...payload });
      showToast(`Agente @${agente.id} atualizado com sucesso!`, "sucesso");
    } catch (err) {
      tratarErro(err, "Falha ao salvar configurações do agente");
    } finally {
      setSalvando(false);
    }
  };

  const toggleSkill = (skillName: string) => {
    setSkillsSelecionadas((prev) =>
      prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName],
    );
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[540px] bg-zinc-950 border-l border-zinc-800 shadow-2xl z-40 flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header do Drawer */}
      <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-emerald-950/60 border border-emerald-800/40 flex items-center justify-center text-emerald-400">
            <Bot size={16} />
          </div>
          <div>
            <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5 font-mono">
              @{agente.id}
            </h3>
            <span className="text-[10px] text-zinc-500">Configuração & Prompt do Sistema</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Tem certeza que deseja excluir permanentemente o agente @${agente.id}?`,
                )
              ) {
                void aoExcluir(agente.id);
              }
            }}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-950/30 transition-colors cursor-pointer"
            title="Excluir agente"
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            onClick={aoFechar}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Formulário de Configuração */}
      <form onSubmit={handleSalvar} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs scrollbar-thin">
        {/* Ativação */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/50 border border-zinc-800">
          <div>
            <span className="text-zinc-200 font-semibold block">Status Operacional</span>
            <span className="text-[11px] text-zinc-500">
              Agentes desativados recusam novas execuções no workspace.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAtivo(!ativo)}
            className={`px-3 py-1 rounded-lg border font-mono text-[11px] transition-all cursor-pointer ${
              ativo
                ? "bg-emerald-950/60 border-emerald-700 text-emerald-300 font-bold"
                : "bg-zinc-900 border-zinc-800 text-zinc-500"
            }`}
          >
            {ativo ? "ATIVO" : "INATIVO"}
          </button>
        </div>

        {/* Papel / Role */}
        <div>
          <label className="block text-zinc-300 font-medium mb-1">
            Papel / Especialidade (Role)
          </label>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Ex: Arquiteto de Software sênior especialista em TypeScript"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        {/* Modelo de Inferência */}
        <div className="space-y-1.5">
          <label className="block text-zinc-300 font-medium">Modelo Principal de IA</label>
          <ModelPicker value={modelSelect} onChange={setModelSelect} motor={harness || undefined} />
        </div>

        {/* Harness & Permissões */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-zinc-300 font-medium mb-1">Harness / Runtime CLI</label>
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
              className="w-full px-2.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-emerald-500 cursor-pointer font-mono"
            >
              {harness && !motoresCatalogo.some((mot) => mot.id === harness) && (
                <option value={harness}>{harness}</option>
              )}
              {motoresCatalogo.map((mot) => (
                <option key={mot.id} value={mot.id}>
                  {mot.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-zinc-300 font-medium mb-1">Nível de Permissão</label>
            <select
              value={permissions}
              onChange={(e) => setPermissions(e.target.value as any)}
              className="w-full px-2.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="level-1">Level 1 — Somente Leitura</option>
              <option value="level-2">Level 2 — Padrão (Edição controlada)</option>
              <option value="level-3">Level 3 — Autônomo / Full Access</option>
            </select>
          </div>
        </div>

        {/* Rotação e Fallback */}
        <div className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-zinc-300 font-medium flex items-center gap-1.5">
              <RotateCcw size={12} className="text-cyan-400" />
              <span>Rotação de Modelos / Fallback</span>
            </span>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-400 mb-1">
              Modelos de Fallback (separados por vírgula)
            </label>
            <ModelPicker value={rotation} onChange={setRotation} multiple motor={harness || undefined} />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="wsRotationFallback"
              checked={workspaceRotationFallback}
              onChange={(e) => setWorkspaceRotationFallback(e.target.checked)}
              className="rounded border-zinc-700 bg-zinc-900 text-emerald-500 cursor-pointer"
            />
            <label
              htmlFor="wsRotationFallback"
              className="text-[11px] text-zinc-400 cursor-pointer select-none"
            >
              Usar rotação global do workspace se os modelos acima falharem
            </label>
          </div>
        </div>

        {/* Skills Disponíveis */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <label className="text-zinc-300 font-medium flex items-center gap-1.5">
              <Puzzle size={13} className="text-amber-400" />
              <span>Skills Atribuídas ({skillsSelecionadas.length})</span>
            </label>
            {carregandoSkills && <Loader2 size={12} className="animate-spin text-zinc-500" />}
          </div>

          <div className="max-h-40 overflow-y-auto space-y-1.5 p-2 rounded-xl bg-zinc-950 border border-zinc-800 scrollbar-thin">
            {skillsDisponiveis.length === 0 && !carregandoSkills && (
              <span className="text-[11px] text-zinc-600 block text-center py-2">
                Nenhuma skill instalada no workspace.
              </span>
            )}
            {skillsDisponiveis.map((sk) => {
              const checked = skillsSelecionadas.includes(sk.nome || sk.id);
              return (
                <label
                  key={sk.id}
                  className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors border ${
                    checked
                      ? "bg-zinc-900/90 border-emerald-800/50 text-zinc-200"
                      : "bg-zinc-950 border-transparent text-zinc-400 hover:bg-zinc-900/40"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSkill(sk.nome || sk.id)}
                    className="rounded border-zinc-700 bg-zinc-900 text-emerald-500"
                  />
                  <div className="min-w-0">
                    <span className="font-mono text-[11px] text-emerald-400 font-semibold block">
                      {sk.nome || sk.id}
                    </span>
                    {sk.descricao && (
                      <span className="text-[10px] text-zinc-500 block truncate">
                        {sk.descricao}
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* System Prompt */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <label className="text-zinc-300 font-medium flex items-center gap-1.5">
              <FileCode size={13} className="text-emerald-400" />
              <span>Prompt do Sistema (System Prompt)</span>
            </label>
            <span className="text-[10px] font-mono text-zinc-500">{prompt.length} caracteres</span>
          </div>

          <textarea
            rows={10}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="# System Prompt: Instruções estruturadas do agente..."
            className="w-full p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 font-mono text-xs leading-relaxed focus:outline-none focus:border-emerald-500 resize-y"
          />
        </div>

        {/* Botão de Salvar no Rodapé do Form */}
        <div className="pt-3 border-t border-zinc-800 flex justify-end gap-2 sticky bottom-0 bg-zinc-950 py-2">
          <button
            type="button"
            onClick={aoFechar}
            className="px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={salvando}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-md transition-colors cursor-pointer disabled:opacity-50"
          >
            {salvando ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            <span>Salvar Alterações</span>
          </button>
        </div>
      </form>
    </div>
  );
};
