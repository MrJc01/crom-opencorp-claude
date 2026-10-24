import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "../utils/paths.js";

const DEFAULT_WEB_DIST = join(projectRoot(), "web-dist");

const ROTA_SPA_RE = /^\/(?:w(?:\/.*)?|home|workspaces|tasks|agentes|secretario|workspace|agenda|fluxos|hooks|apps|ativos|secrets|reunioes|historico|notificacoes|analytics|docs|config|app)(?:\/.*)?$/;

const TIPOS_TEXTO: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
};

const TIPOS_BINARIO: Record<string, string> = {
  png: "image/png",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
};

/**
 * Lê e resolve arquivo estático a partir do diretório web-dist.
 */
export function servirEstatico(rota: string, customWebDist?: string): { tipo: string; corpo: string | Buffer } | null {
  try {
    const raiz = customWebDist ? resolve(customWebDist) : DEFAULT_WEB_DIST;
    const caminhoRel = rota === "/" ? "index.html" : rota.replace(/^\/+/, "");
    const alvo = resolve(raiz, caminhoRel);
    if (!alvo.startsWith(raiz)) return null;

    if (!existsSync(alvo) || !statSync(alvo).isFile()) {
      if (caminhoRel.includes(".")) return null;
      const indexPath = join(raiz, "index.html");
      if (!existsSync(indexPath)) return null;
      return { tipo: "text/html; charset=utf-8", corpo: readFileSync(indexPath, "utf8") };
    }

    const ext = (caminhoRel.split(".").pop() ?? "").toLowerCase();
    if (TIPOS_TEXTO[ext]) {
      return { tipo: TIPOS_TEXTO[ext]!, corpo: readFileSync(alvo, "utf8") };
    }
    if (TIPOS_BINARIO[ext]) {
      return { tipo: TIPOS_BINARIO[ext]!, corpo: readFileSync(alvo) };
    }
    return { tipo: "application/octet-stream", corpo: readFileSync(alvo) };
  } catch {
    return null;
  }
}

/**
 * Cria manipulador HTTP para arquivos estáticos e fallback SPA.
 */
export function criarHandlerEstatico(webDistDir?: string) {
  const raiz = webDistDir ? resolve(webDistDir) : DEFAULT_WEB_DIST;

  return async (req: IncomingMessage, res: ServerResponse, rota: string): Promise<boolean> => {
    // 1. Arquivos estáticos públicos diretos (/ ou extensões .js, .css, .svg, etc.)
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (rota === "/" || /\.[a-z0-9]+$/i.test(rota)) &&
      rota !== "/events" &&
      !rota.startsWith("/settings/") &&
      rota !== "/doc"
    ) {
      const estatico = servirEstatico(rota, raiz);
      if (estatico !== null) {
        res.writeHead(200, {
          "content-type": estatico.tipo,
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        });
        if (req.method === "HEAD") res.end();
        else res.end(estatico.corpo);
        return true;
      }
    }

    // 2. SPA fallback para rotas de navegação (HTML5 History API)
    const accept = String(req.headers.accept || "");
    const querHtml = accept.includes("text/html");
    if (
      req.method === "GET" &&
      querHtml &&
      ROTA_SPA_RE.test(rota)
    ) {
      const index = servirEstatico("/", raiz);
      if (index !== null) {
        res.writeHead(200, {
          "content-type": index.tipo,
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        });
        res.end(index.corpo);
        return true;
      }
    }

    return false;
  };
}
