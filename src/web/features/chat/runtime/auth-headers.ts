/** Cabeçalho Authorization a partir do token guardado pelo login da UI. */
export function obterAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const t = localStorage.getItem("oc-token") || localStorage.getItem("opencorp_token");
    if (t) headers["Authorization"] = `Bearer ${t.trim()}`;
  }
  return headers;
}

export function originAtual(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";
}
