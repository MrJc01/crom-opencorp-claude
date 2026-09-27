/**
 * Garante o token da API em toda requisição same-origin da UI.
 *
 * Vários componentes usam `fetch` direto (árvore de arquivos, terminal, Git,
 * streaming do Secretário…) e não enviavam `Authorization`; com
 * `opencorp serve --token` essas telas falhavam com 401. O token nunca é
 * enviado para outras origens.
 */
function tokenSalvo(): string {
  try {
    return localStorage.getItem("oc-token") || localStorage.getItem("opencorp_token") || "";
  } catch {
    return "";
  }
}

function mesmaOrigem(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function instalarFetchAutenticado(): void {
  if (typeof window === "undefined" || (window.fetch as { __ocAuth?: boolean }).__ocAuth) return;
  const original = window.fetch.bind(window);
  const comToken: typeof window.fetch = (input, init) => {
    const token = tokenSalvo();
    if (!token || !mesmaOrigem(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
  (comToken as { __ocAuth?: boolean }).__ocAuth = true;
  window.fetch = comToken;
}
