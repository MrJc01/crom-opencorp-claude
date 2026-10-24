export const ROTAS_GLOBAIS = ["/", "/workspaces", "/analytics", "/config/global", "/docs"] as const;

/**
 * Monta a URL canônica de um módulo pertencente a um workspace.
 */
export function workspacePath(
  workspaceId: string,
  modulo = "",
  params?: Record<string, string | null | undefined>,
): string {
  const id = workspaceId.trim();
  const moduloNormalizado = modulo
    .trim()
    .split("/")
    .filter(Boolean)
    .map((segmento) => encodeURIComponent(segmento))
    .join("/");
  const pathname = `/w/${encodeURIComponent(id)}${moduloNormalizado ? `/${moduloNormalizado}` : ""}`;

  if (!params) return pathname;

  const query = new URLSearchParams();
  for (const [chave, valor] of Object.entries(params)) {
    const chaveValida = chave.trim();
    if (!chaveValida || valor === null || valor === undefined) continue;
    query.append(chaveValida, valor);
  }

  const queryString = query.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

/**
 * Extrai e decodifica o workspace de caminhos no formato /w/:workspaceId/*.
 */
export function extrairWorkspaceDaUrl(pathname: string): string | null {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;

  try {
    const workspaceId = decodeURIComponent(match[1]).trim();
    return workspaceId || null;
  } catch {
    return null;
  }
}
