import { useEffect, useState } from "react";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";

/** Manifest do motor como o servidor o expõe em GET /api/motores. */
export interface MotorManifestWeb {
  limits: { tetoMs?: number; inatividadeMs?: number } | null;
  modelPrefixes: string[] | null;
  instructionFiles: string[] | null;
  toolPolicyModes: string[] | null;
}

export interface MotorAuthWeb {
  title?: string;
  cliCommand?: string;
  envVar?: string;
  url?: string;
  urlText?: string;
  desc?: string;
  webPrompt?: string;
  login?: { web: boolean; codigo: boolean; importar?: boolean };
}

export interface MotorCatalogo {
  id: string;
  name: string;
  installed?: boolean;
  supportsConversation?: boolean;
  manifest: MotorManifestWeb | null;
  auth: MotorAuthWeb | null;
}

type ClienteHttp = { http: { get<T>(url: string): Promise<T> } };

let cache: MotorCatalogo[] | null = null;
let emVoo: Promise<MotorCatalogo[]> | null = null;
const ouvintes = new Set<(m: MotorCatalogo[]) => void>();

/** Único ponto que lê os motores do registry; cacheia e reaproveita a requisição em andamento. */
export function carregarMotores(client: ClienteHttp, forcar = false): Promise<MotorCatalogo[]> {
  if (cache && !forcar) return Promise.resolve(cache);
  if (emVoo) return emVoo;
  emVoo = client.http
    .get<{ motores?: MotorCatalogo[] }>("/api/motores")
    .then((res) => {
      cache = Array.isArray(res?.motores) ? res.motores : [];
      ouvintes.forEach((fn) => fn(cache!));
      return cache;
    })
    .catch(() => cache ?? [])
    .finally(() => {
      emVoo = null;
    });
  return emVoo;
}

/** Motores do registry (lista vazia até carregar). */
export function useMotoresCatalogo(): MotorCatalogo[] {
  const { client } = useOpenCorp();
  const [motores, setMotores] = useState<MotorCatalogo[]>(cache ?? []);
  useEffect(() => {
    ouvintes.add(setMotores);
    void carregarMotores(client as unknown as ClienteHttp).then(setMotores);
    return () => {
      ouvintes.delete(setMotores);
    };
  }, [client]);
  return motores;
}

/** Motor cujo `modelPrefixes` cobre o modelo; `undefined` se nenhum declarar. */
export function motorDoModelo(motores: MotorCatalogo[], modelo: string): MotorCatalogo | undefined {
  const m = (modelo || "").trim().toLowerCase();
  return motores.find((x) => (x.manifest?.modelPrefixes ?? []).some((p) => m.startsWith(p.toLowerCase())));
}

/** Descarta o cache (ex.: depois de instalar ou conectar um motor). */
export function invalidarMotores(): void {
  cache = null;
}
