import React, { useEffect, useState, type FC, type FormEvent, type ReactNode } from "react";
import { KeyRound, Loader2 } from "lucide-react";

/**
 * Portão de autenticação da UI. O servidor pode rodar aberto (padrão) ou com
 * token (`opencorp serve --token`). Quando a API responde 401, mostra a tela de
 * login; o token vem do formulário ou de `?token=` na URL e fica em localStorage.
 */
type Estado = "verificando" | "liberado" | "login";

const CHAVE = "oc-token";

function lerToken(): string {
  try {
    return localStorage.getItem(CHAVE) || localStorage.getItem("opencorp_token") || "";
  } catch {
    return "";
  }
}

function gravarToken(token: string): void {
  try {
    localStorage.setItem(CHAVE, token);
  } catch {
    // storage bloqueado: segue só nesta sessão
  }
}

async function tokenAceito(token: string): Promise<boolean> {
  const resp = await fetch("/workspaces", { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return resp.status !== 401;
}

export const AuthGate: FC<{ children: ReactNode }> = ({ children }) => {
  const [estado, setEstado] = useState<Estado>("verificando");
  const [versao, setVersao] = useState(0);
  const [token, setToken] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    // `?token=` na URL (link impresso pelo serve) vira o token salvo e sai da barra de endereço.
    const url = new URL(window.location.href);
    const daUrl = url.searchParams.get("token");
    if (daUrl) {
      gravarToken(daUrl);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    tokenAceito(lerToken())
      .then((ok) => setEstado(ok ? "liberado" : "login"))
      .catch(() => setEstado("liberado")); // servidor inacessível: as telas mostram o erro
  }, []);

  const entrar = async (e: FormEvent) => {
    e.preventDefault();
    const valor = token.trim();
    if (!valor) {
      setErro("Informe o token de acesso.");
      return;
    }
    setEnviando(true);
    setErro(null);
    try {
      if (await tokenAceito(valor)) {
        gravarToken(valor);
        setVersao((v) => v + 1); // remonta o app com o token novo
        setEstado("liberado");
      } else {
        setErro("Token inválido. Confira o token exibido pelo `opencorp serve --token`.");
      }
    } catch {
      setErro("Não foi possível falar com o servidor OpenCorp.");
    } finally {
      setEnviando(false);
    }
  };

  if (estado === "verificando") {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400" role="status">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" />
        <span className="sr-only">Verificando acesso…</span>
      </div>
    );
  }

  if (estado === "login") {
    return (
      <main id="login-screen" className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
        <form onSubmit={entrar} className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6" aria-labelledby="login-titulo">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-orange-400" aria-hidden="true" />
            <h1 id="login-titulo" className="text-base font-bold text-zinc-100">Entrar no OpenCorp</h1>
          </div>
          <p className="text-xs text-zinc-400">Este servidor exige um token de acesso.</p>
          <div className="space-y-1">
            <label htmlFor="login-token" className="block text-xs font-medium text-zinc-300">Token de acesso</label>
            <input
              id="login-token"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={erro ? true : undefined}
              aria-describedby={erro ? "login-error" : undefined}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none"
            />
          </div>
          {erro && (
            <p id="login-error" role="alert" className="text-xs text-rose-300">{erro}</p>
          )}
          <button
            id="login-btn"
            type="submit"
            disabled={enviando}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-700 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {enviando && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Entrar
          </button>
        </form>
      </main>
    );
  }

  return <div id="app" key={versao} className="contents">{children}</div>;
};
