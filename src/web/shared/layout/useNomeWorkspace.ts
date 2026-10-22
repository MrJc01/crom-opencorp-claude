import { useEffect, useState } from "react";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";

/** Nome de exibição do workspace ativo (campo `nome` de workspaces.json); cai no id quando não há. */
export function useNomeWorkspace(): string {
  const { client, workspaceId } = useOpenCorp();
  const [nome, setNome] = useState("");
  useEffect(() => {
    let vivo = true;
    setNome("");
    if (!workspaceId) return;
    client.workspaces
      .listar()
      .then((lista) => {
        const ws = lista.find((w) => w.id === workspaceId);
        if (vivo && typeof ws?.nome === "string") setNome(ws.nome);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [client, workspaceId]);
  return nome || workspaceId || "";
}
