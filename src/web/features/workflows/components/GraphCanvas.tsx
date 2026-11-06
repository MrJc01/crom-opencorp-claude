import React, {
  useCallback,
  useMemo,
  useRef,
  type DragEvent,
  type FC,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  MarkerType,
  BackgroundVariant,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { TriggerNode } from "./nodes/TriggerNode.js";
import { AgentNode } from "./nodes/AgentNode.js";
import { LogicNode } from "./nodes/LogicNode.js";
import { IntegrationNode } from "./nodes/IntegrationNode.js";
import { OutputNode } from "./nodes/OutputNode.js";
import type { NoGrafo, FluxoCompleto } from "../types.js";

// Mapeamento dos Custom Node Components no React Flow
const nodeTypes: NodeTypes = {
  triggerNode: TriggerNode,
  agentNode: AgentNode,
  logicNode: LogicNode,
  integrationNode: IntegrationNode,
  outputNode: OutputNode,
};

// Determina qual Custom Node do React Flow renderiza o tipo OpenCorp
export function resolverTipoReactFlow(tipo: string): string {
  switch (tipo) {
    case "cron":
    case "webhook":
    case "manual":
      return "triggerNode";
    case "agente":
    case "fanout":
    case "review":
    case "debate":
      return "agentNode";
    case "condicao":
    case "decisao":
    case "loop":
    case "delay":
    case "subflow":
      return "logicNode";
    case "script":
    case "http_request":
    case "componente":
      return "integrationNode";
    case "saida":
    case "task_create":
    case "registro":
    case "reuniao":
      return "outputNode";
    default:
      return "integrationNode";
  }
}

export interface GraphCanvasProps {
  fluxo: FluxoCompleto;
  noSelecionadoId: string | null;
  onSelecionarNo: (no: NoGrafo | null) => void;
  onAtualizarGrafo: (nos: NoGrafo[], arestas: any[]) => void;
  onAdicionarNodeTipo: (tipo: string, posicao?: { x: number; y: number }) => void;
  /** Nó sob o mouse (null ao sair): alimenta o painel lateral de comentário. */
  onPassarMouseNo?: (no: NoGrafo | null) => void;
  /** Muda a cada "organizar nós": enquadra a vista no novo layout. */
  ajustarVista?: number;
}

const GraphCanvasInner: FC<GraphCanvasProps> = ({
  fluxo,
  noSelecionadoId,
  onSelecionarNo,
  onAtualizarGrafo,
  onAdicionarNodeTipo,
  onPassarMouseNo,
  ajustarVista,
}) => {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Converte nós OpenCorp para ReactFlow Nodes
  const initialNodes: Node[] = useMemo(() => {
    const rawNos = Array.isArray(fluxo.nos) ? fluxo.nos : [];
    return rawNos.map((no, idx) => {
      const rfType = resolverTipoReactFlow(no.tipo);
      const posX = no.pos?.x ?? (idx % 4) * 280 + 80;
      const posY = no.pos?.y ?? Math.floor(idx / 4) * 160 + 80;

      return {
        id: no.id,
        type: rfType,
        position: { x: posX, y: posY },
        data: { no },
        selected: no.id === noSelecionadoId,
      };
    });
  }, [fluxo.nos, noSelecionadoId]);

  // Converte arestas OpenCorp para ReactFlow Edges
  const initialEdges: Edge[] = useMemo(() => {
    const rawArestas = Array.isArray(fluxo.arestas) ? fluxo.arestas : [];
    const nosPorId = new Map((Array.isArray(fluxo.nos) ? fluxo.nos : []).map((n) => [n.id, n]));
    return rawArestas.map((a, idx) => {
      // Nó "condicao": o arquivo guarda o destino em config.entao/config.senao e a aresta sem "saida".
      // Sem isso as duas linhas saíam do primeiro ponto (o verde).
      const origem = nosPorId.get(a.de);
      const cfg = (origem?.config ?? {}) as Record<string, unknown>;
      const ramoDoNo = origem && (origem.tipo === "condicao" || origem.tipo === "decisao")
        ? cfg.entao === a.para && cfg.senao !== a.para ? "entao" : cfg.senao === a.para && cfg.entao !== a.para ? "senao" : undefined
        : undefined;
      const saida: string | undefined = a.saida || (a.condicao === "entao" || a.condicao === "senao" ? a.condicao : undefined) || ramoDoNo;
      const isEntao = saida === "entao";
      const isSenao = saida === "senao";

      const cor = isEntao ? "#10b981" : isSenao ? "#f43f5e" : "#f97316";

      return {
        id: `e-${a.de}-${a.para}-${saida || idx}`,
        source: a.de,
        target: a.para,
        sourceHandle: saida,
        type: "smoothstep",
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: cor,
          width: 14,
          height: 14,
        },
        style: {
          stroke: cor,
          strokeWidth: 2,
        },
        label: a.rotulo || (isEntao ? "então" : isSenao ? "senão" : undefined),
        labelStyle: {
          fill: cor,
          fontWeight: 600,
          fontSize: 10,
          fontFamily: "monospace",
        },
        labelBgStyle: {
          fill: "#09090b",
          fillOpacity: 0.85,
        },
      };
    });
  }, [fluxo.arestas, fluxo.nos]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sincroniza nós e arestas quando o fluxo externo muda
  React.useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  React.useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Enquadra a vista depois de "organizar nós" (espera o React Flow receber as novas posições).
  React.useEffect(() => {
    if (!ajustarVista) return;
    const t = setTimeout(() => void fitView({ padding: 0.2, duration: 400 }), 60);
    return () => clearTimeout(t);
  }, [ajustarVista, fitView]);

  const aoEntrarNo = useCallback(
    (_: React.MouseEvent, node: Node) => onPassarMouseNo?.((Array.isArray(fluxo.nos) ? fluxo.nos : []).find((n) => n.id === node.id) ?? null),
    [fluxo.nos, onPassarMouseNo]
  );
  const aoSairNo = useCallback(() => onPassarMouseNo?.(null), [onPassarMouseNo]);

  // Notifica o pai quando os nós são arrastados/movidos
  const handleNodeDragStop = useCallback(
    (_: any, node: Node) => {
      const nosList = Array.isArray(fluxo.nos) ? fluxo.nos : [];
      const arestasList = Array.isArray(fluxo.arestas) ? fluxo.arestas : [];
      const novosNos = nosList.map((no) => {
        if (no.id === node.id) {
          return {
            ...no,
            pos: {
              x: Math.round(node.position.x),
              y: Math.round(node.position.y),
            },
          };
        }
        return no;
      });
      onAtualizarGrafo(novosNos, arestasList);
    },
    [fluxo.nos, fluxo.arestas, onAtualizarGrafo]
  );

  // Conexão entre nós
  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      if (params.source === params.target) return;

      const nosList = Array.isArray(fluxo.nos) ? fluxo.nos : [];
      const arestasList = Array.isArray(fluxo.arestas) ? fluxo.arestas : [];

      const novaAresta = {
        de: params.source,
        para: params.target,
        saida: params.sourceHandle || undefined,
        rotulo:
          params.sourceHandle === "entao"
            ? "então"
            : params.sourceHandle === "senao"
            ? "senão"
            : undefined,
      };

      // Evita duplicatas
      const jaExiste = arestasList.some(
        (a) => a.de === novaAresta.de && a.para === novaAresta.para && a.saida === novaAresta.saida
      );
      if (!jaExiste) {
        const novasArestas = [...arestasList, novaAresta];
        onAtualizarGrafo(nosList, novasArestas);
      }
    },
    [fluxo.nos, fluxo.arestas, onAtualizarGrafo]
  );

  // Drag and drop da paleta para o canvas
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const tipo = event.dataTransfer.getData("application/reactflow-type");
      if (!tipo) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      onAdicionarNodeTipo(tipo, {
        x: Math.round(position.x),
        y: Math.round(position.y),
      });
    },
    [screenToFlowPosition, onAdicionarNodeTipo]
  );

  // Clique em um nó
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const nosList = Array.isArray(fluxo.nos) ? fluxo.nos : [];
      const achado = nosList.find((n) => n.id === node.id) || null;
      onSelecionarNo(achado);
    },
    [fluxo.nos, onSelecionarNo]
  );

  // Clique no fundo do canvas desmarca nó
  const onPaneClick = useCallback(() => {
    onSelecionarNo(null);
  }, [onSelecionarNo]);

  return (
    <div ref={reactFlowWrapper} className="w-full h-full relative select-none">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={aoEntrarNo}
        onNodeMouseLeave={aoSairNo}
        onPaneClick={onPaneClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2.5}
        defaultEdgeOptions={{
          type: "smoothstep",
          animated: true,
        }}
        className="bg-zinc-950"
      >
        <Background variant={BackgroundVariant.Dots} color="#27272a" gap={20} size={1.5} />
        <Controls className="!bg-zinc-900 !border-zinc-800 !fill-zinc-300 [&>button]:!bg-zinc-900 [&>button]:!border-zinc-800 [&>button]:!text-zinc-300 [&>button:hover]:!bg-zinc-800" />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case "triggerNode":
                return "#38bdf8";
              case "agentNode":
                return "#10b981";
              case "logicNode":
                return "#f59e0b";
              case "integrationNode":
                return "#06b6d4";
              case "outputNode":
                return "#10b981";
              default:
                return "#71717a";
            }
          }}
          maskColor="rgba(9, 9, 11, 0.75)"
          className="!bg-zinc-900 !border-zinc-800 rounded-lg overflow-hidden !m-3 shadow-lg"
        />
      </ReactFlow>
    </div>
  );
};

export const GraphCanvas: FC<GraphCanvasProps> = (props) => {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
};
