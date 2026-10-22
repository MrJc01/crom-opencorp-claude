/**
 * Rotas de Arquivos do Workspace — Extração Modular (MICRO-PASSO 15)
 * Manipula /files, /files/raw (com Range), /files/tree, criação, edição e exclusão.
 */

import { stat, lstat, readlink, readdir, readFile, realpath, open, mkdir, rename, rm, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { WorkspaceError } from "../../core/shared/errors.js";
import { writeFileAtomic } from "../../utils/fs-safe.js";
import type { RouteContext } from "./types.js";

/** Valida e resolve caminho dentro do workspace (anti path-traversal). */
export async function resolverCaminhoWorkspace(wsPath: string, pathParam: string): Promise<string> {
  const base = resolve(wsPath);
  const solicitado = pathParam ?? "";
  const normalizado = solicitado.replace(/^\.\//, "").replace(/\/+/g, "/");
  const alvo = resolve(base, normalizado);
  const relativo = relative(base, alvo);
  if (relativo.startsWith("..") || isAbsolute(relativo)) {
    throw new WorkspaceError("caminho fora do workspace (path traversal bloqueado)", { exitCode: 3 });
  }
  return alvo;
}

/**
 * Resolve o caminho de um arquivo dentro do workspace garantindo proteção contra
 * path-traversal e resiliência com symlinks e arquivos de mídia rotacionados/arquivados.
 */
async function resolverArquivoOuSymlink(wsPath: string, pathParam: string): Promise<string> {
  const alvo = await resolverCaminhoWorkspace(wsPath, pathParam);
  try {
    await stat(alvo);
    return alvo;
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      try {
        const lst = await lstat(alvo);
        if (lst.isSymbolicLink()) {
          const linkDest = await readlink(alvo);
          const destAbs = isAbsolute(linkDest) ? linkDest : resolve(dirname(alvo), linkDest);
          const cands = [
            destAbs,
            destAbs.replace("/exports/videos/", "/exports/videos/_versoes_substituidas/"),
            destAbs.replace("/exports/videos/_versoes_substituidas/", "/exports/videos/"),
            destAbs.replace("/exports/videos/", "/exports/videos/_mock_arquivado_2026-09-08/"),
          ];
          for (const cand of cands) {
            try {
              const st = await stat(cand);
              if (st.isFile() || st.isDirectory()) return cand;
            } catch {}
          }
        }
      } catch {}

      const matchVid = pathParam.match(/(vid-[a-z0-9]+)\/([^\/]+)$/i);
      if (matchVid) {
        const [, vidId, nomeArquivo] = matchVid;
        const cands = [
          join(wsPath, "exports/videos", vidId, nomeArquivo),
          join(wsPath, "exports/videos/_versoes_substituidas", vidId, nomeArquivo),
          join(wsPath, "exports/videos/_mock_arquivado_2026-09-08", vidId, nomeArquivo),
        ];
        for (const cand of cands) {
          try {
            const st = await stat(cand);
            if (st.isFile()) return cand;
          } catch {}
        }
      }
    }
    throw e;
  }
}

function obterMimeType(caminho: string): string {
  const ext = caminho.split(".").pop()?.toLowerCase() ?? "";
  const mapa: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    avif: "image/avif",
    bmp: "image/bmp",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
  };
  return mapa[ext] || "application/octet-stream";
}

function ehMidia(caminho: string): boolean {
  const mime = obterMimeType(caminho);
  return mime.startsWith("video/") || mime.startsWith("image/") || mime.startsWith("audio/") || mime === "application/pdf";
}

export interface ResultadoLerArquivo {
  tipo: "arquivo";
  conteudo: string | null;
  motivo?: string;
  binario?: boolean;
  tamanho?: number;
  mime?: string;
}

async function lerArquivoWorkspace(alvo: string, base: string): Promise<ResultadoLerArquivo> {
  const real = await realpath(alvo).catch(() => null);
  if (!real || (!isAbsolute(base) ? false : relative(resolve(base), real).startsWith(".."))) {
    return { tipo: "arquivo", conteudo: null, motivo: "symlink fora do workspace (bloqueado)" };
  }
  const info = await stat(alvo);
  if (ehMidia(alvo)) {
    const mime = obterMimeType(alvo);
    return {
      tipo: "arquivo",
      conteudo: null,
      binario: true,
      tamanho: info.size,
      mime,
      motivo: `Mídia (${mime})`,
    };
  }
  if (info.size > 512 * 1024) {
    return { tipo: "arquivo", conteudo: null, motivo: "arquivo excede 512KB", binario: true, tamanho: info.size, mime: obterMimeType(alvo) };
  }
  if (info.size > 0) {
    const fd = await open(alvo, "r");
    try {
      const sniff = Buffer.alloc(Math.min(info.size, 8 * 1024));
      await fd.read(sniff, 0, sniff.length, 0);
      if (sniff.includes(0)) {
        return { tipo: "arquivo", conteudo: null, motivo: "binário", binario: true, tamanho: info.size, mime: obterMimeType(alvo) };
      }
    } finally {
      await fd.close();
    }
  }
  const conteudo = await readFile(alvo, "utf8");
  return { tipo: "arquivo", conteudo, binario: false, tamanho: info.size, mime: obterMimeType(alvo) };
}

interface NoArvore {
  nome: string;
  caminho: string;
  tipo: "dir" | "arquivo";
  tamanho?: number;
  filhos?: NoArvore[];
}

const ARVORE_IGNORAR_DIRS = new Set([
  "node_modules",
  ".git",
  ".opencode",
  "opencode",
  "dist",
  "web-dist",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  "coverage",
  "execucoes",
  "opencode-data",
  "opencode-config",
  ".turbo",
]);
const ARVORE_CAP_NOS = 15000;

/**
 * Árvore do workspace em largura (nível por nível): o teto de nós só corta os níveis mais fundos, nunca uma pasta
 * da raiz. Antes a busca era em profundidade e `.opencorp` (ordem alfabética) gastava os 15 mil nós, deixando
 * exports, registries, scripts etc. vazias no IDE.
 */
export async function construirArvore(raiz: string, profundidadeMax: number, cap = ARVORE_CAP_NOS): Promise<{ arvore: NoArvore[]; truncado: boolean }> {
  let total = 0;
  let truncado = false;

  async function lerDir(dirAbs: string, rel: string): Promise<NoArvore[]> {
    let entradas: import("node:fs").Dirent[] = [];
    try {
      entradas = (await readdir(dirAbs, { withFileTypes: true })).filter((e) => {
        if (ARVORE_IGNORAR_DIRS.has(e.name)) return false;
        if (e.name.startsWith(".") && e.name !== ".opencorp" && e.name !== ".gitignore" && e.name !== ".env") return false;
        if (e.name.endsWith(".log") || e.name.endsWith(".db-wal") || e.name.endsWith(".db-shm")) return false;
        return true;
      });
    } catch {
      return [];
    }
    entradas.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nos: NoArvore[] = [];
    for (const e of entradas) {
      const caminho = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nos.push({ nome: e.name, caminho, tipo: "dir", filhos: [] });
      } else {
        let tamanho: number | undefined;
        try {
          tamanho = (await stat(join(dirAbs, e.name))).size;
        } catch {}
        nos.push({ nome: e.name, caminho, tipo: "arquivo", tamanho });
      }
    }
    return nos;
  }

  const arvore = await lerDir(raiz, "");
  total += arvore.length;
  let nivel = arvore.filter((n) => n.tipo === "dir");
  for (let profundidade = 2; profundidade <= profundidadeMax && nivel.length > 0; profundidade++) {
    // O teto vale entre níveis: um nível é sempre listado por inteiro, assim nenhuma pasta irmã fica vazia.
    if (total >= cap) {
      truncado = true;
      break;
    }
    const proximo: NoArvore[] = [];
    for (const dir of nivel) {
      dir.filhos = await lerDir(join(raiz, dir.caminho), dir.caminho);
      total += dir.filhos.length;
      for (const f of dir.filhos) if (f.tipo === "dir") proximo.push(f);
    }
    nivel = proximo;
  }
  return { arvore, truncado };
}

function extrairPathWorkspace(ws: { path?: string; caminho?: string } | null | undefined): string {
  if (!ws) return "";
  const obj = ws as Record<string, unknown>;
  if (typeof obj.caminho === "string" && obj.caminho.trim().length > 0) {
    return obj.caminho.trim();
  }
  if (typeof obj.path === "string" && obj.path.trim().length > 0) {
    return obj.path.trim();
  }
  return "";
}

export async function handleFilesRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, lerCorpo, enviar, workspaces } = ctx;

  if (!rota.startsWith("/files")) {
    return false;
  }

  // ── 1. GET /files — lista diretório ou lê arquivo do workspace
  if (rota === "/files" && req.method === "GET") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const pathParam = url.searchParams.get("path") ?? "";
    try {
      let alvo = "";
      let wsAlvo = ws;
      try {
        alvo = await resolverArquivoOuSymlink(wsPath, pathParam);
        await stat(alvo);
      } catch (e: any) {
        if (pathParam && (e?.code === "ENOENT" || e instanceof WorkspaceError)) {
          let achou = false;
          const todos = await workspaces.listar().catch(() => []);
          for (const outro of todos) {
            if (outro.id === ws.id || !outro.path) continue;
            try {
              const testAlvo = await resolverArquivoOuSymlink(outro.path, pathParam);
              await stat(testAlvo);
              alvo = testAlvo;
              wsAlvo = outro as any;
              achou = true;
              break;
            } catch {}
          }
          if (!achou) throw e;
        } else {
          throw e;
        }
      }

      const info = await stat(alvo);
      if (info.isDirectory()) {
        const entradas = await readdir(alvo, { withFileTypes: true });
        const itensComTamanho = await Promise.all(
          entradas.map(async (e) => {
            const fullPath = join(alvo, e.name);
            let tamanho = 0;
            try {
              const st = await stat(fullPath);
              tamanho = st.size;
            } catch {}
            return { nome: e.name, tipo: e.isDirectory() ? "dir" : "arquivo", tamanho };
          })
        );
        enviar(res, 200, { tipo: "dir", itens: itensComTamanho });
      } else {
        const resultado = await lerArquivoWorkspace(alvo, extrairPathWorkspace(wsAlvo));
        const urlRaw = `/files/raw?path=${encodeURIComponent(pathParam)}&workspace=${encodeURIComponent(wsAlvo.id)}`;
        enviar(res, 200, {
          ...resultado,
          workspace: wsAlvo.id,
          caminho: pathParam,
          urlRaw,
        });
      }
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else if ((erro as NodeJS.ErrnoException).code === "ENOENT") {
        enviar(res, 404, { erro: "arquivo ou diretório não encontrado" });
      } else {
        throw erro;
      }
    }
    return true;
  }

  // ── 2. GET/HEAD /files/raw — stream binário direto com suporte a Range
  if (rota === "/files/raw" && (req.method === "GET" || req.method === "HEAD")) {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const pathParam = url.searchParams.get("path") ?? "";
    if (!pathParam) {
      enviar(res, 400, { erro: "parâmetro 'path' é obrigatório" });
      return true;
    }
    try {
      let alvo = "";
      try {
        alvo = await resolverArquivoOuSymlink(wsPath, pathParam);
        await stat(alvo);
      } catch (e: any) {
        if (e?.code === "ENOENT" || e instanceof WorkspaceError) {
          let achou = false;
          const todos = await workspaces.listar().catch(() => []);
          for (const outro of todos) {
            const outroPath = extrairPathWorkspace(outro);
            if (outro.id === ws.id || !outroPath) continue;
            try {
              const testAlvo = await resolverArquivoOuSymlink(outroPath, pathParam);
              await stat(testAlvo);
              alvo = testAlvo;
              achou = true;
              break;
            } catch {}
          }
          if (!achou) throw e;
        } else {
          throw e;
        }
      }

      const info = await stat(alvo);
      if (info.isDirectory()) {
        enviar(res, 400, { erro: "o caminho aponta para um diretório, não um arquivo" });
        return true;
      }

      const mime = obterMimeType(alvo);
      const range = req.headers.range;

      if (range && range.startsWith("bytes=")) {
        const partes = range.replace(/bytes=/, "").split("-");
        const start = parseInt(partes[0], 10);
        const end = partes[1] ? parseInt(partes[1], 10) : info.size - 1;

        if (isNaN(start) || start >= info.size || (end && end >= info.size)) {
          res.writeHead(416, {
            "Content-Range": `bytes */${info.size}`,
            "Access-Control-Allow-Origin": "*",
          });
          res.end();
          return true;
        }

        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${info.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": mime,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        if (req.method === "HEAD") {
          res.end();
          return true;
        }
        const stream = createReadStream(alvo, { start, end });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": info.size,
          "Content-Type": mime,
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        if (req.method === "HEAD") {
          res.end();
          return true;
        }
        const stream = createReadStream(alvo);
        stream.pipe(res);
      }
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else if ((erro as NodeJS.ErrnoException).code === "ENOENT") {
        enviar(res, 404, { erro: "arquivo não encontrado" });
      } else {
        throw erro;
      }
    }
    return true;
  }

  // ── 3. GET /files/tree — árvore recursiva do workspace
  if (rota === "/files/tree" && req.method === "GET") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const profBruta = Number(url.searchParams.get("profundidade"));
    const profundidade = Math.min(6, Math.max(1, Number.isFinite(profBruta) ? Math.floor(profBruta) : 4));
    const { arvore, truncado } = await construirArvore(wsPath, profundidade);
    enviar(res, 200, { tipo: "arvore", arvore, truncado });
    return true;
  }

  // ── 4. PUT /files — salva conteúdo de arquivo EXISTENTE
  if (rota === "/files" && req.method === "PUT") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const pathParam = url.searchParams.get("path") ?? "";
    let corpo: { conteudo?: unknown };
    try {
      corpo = (await lerCorpo(req, 1.5 * 1024 * 1024)) as { conteudo?: unknown };
    } catch {
      enviar(res, 413, { erro: "corpo excede o limite de 1MB" });
      return true;
    }
    const conteudo = typeof corpo.conteudo === "string" ? corpo.conteudo : String(corpo.conteudo ?? "");
    if (Buffer.byteLength(conteudo, "utf8") > 1024 * 1024) {
      enviar(res, 413, { erro: "conteúdo excede 1MB" });
      return true;
    }
    try {
      const alvo = await resolverCaminhoWorkspace(wsPath, pathParam);
      const real = await realpath(alvo).catch(() => null);
      if (!real || relative(resolve(wsPath), real).startsWith("..")) {
        enviar(res, 403, { erro: "symlink fora do workspace (bloqueado)" });
        return true;
      }
      const info = await stat(alvo).catch(() => null);
      if (!info?.isFile()) {
        enviar(res, 404, { erro: "arquivo não encontrado (escrita não cria paths novos nesta etapa)" });
        return true;
      }
      await writeFileAtomic(alvo, conteudo, { encoding: "utf8", createDirs: false });
      enviar(res, 200, { ok: true });
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else if ((erro as NodeJS.ErrnoException).code === "ENOENT") {
        enviar(res, 404, { erro: "arquivo não encontrado (escrita não cria paths novos nesta etapa)" });
      } else {
        throw erro;
      }
    }
    return true;
  }

  // ── 5. POST /files — cria arquivo ou pasta no workspace
  if (rota === "/files" && req.method === "POST") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const corpo = (await lerCorpo(req)) as { path?: string; tipo?: "arquivo" | "dir"; conteudo?: string };
    const pathParam = String(corpo.path ?? "").trim();
    if (!pathParam) {
      enviar(res, 400, { erro: "caminho (path) é obrigatório" });
      return true;
    }
    try {
      const alvo = await resolverCaminhoWorkspace(wsPath, pathParam);
      const tipo = corpo.tipo === "dir" ? "dir" : "arquivo";
      if (tipo === "dir") {
        await mkdir(alvo, { recursive: true });
      } else {
        await mkdir(dirname(alvo), { recursive: true });
        await writeFileAtomic(alvo, String(corpo.conteudo ?? ""), { encoding: "utf8", createDirs: true });
      }
      enviar(res, 201, { ok: true, path: pathParam, tipo });
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else {
        enviar(res, 500, { erro: `erro ao criar: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
    }
    return true;
  }

  // ── 6. DELETE /files — remove arquivo ou pasta no workspace
  if (rota === "/files" && req.method === "DELETE") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const pathParam = String(url.searchParams.get("path") ?? "").trim();
    if (!pathParam || pathParam === "." || pathParam === "/") {
      enviar(res, 400, { erro: "caminho inválido para exclusão" });
      return true;
    }
    try {
      const alvo = await resolverCaminhoWorkspace(wsPath, pathParam);
      const info = await stat(alvo).catch(() => null);
      if (!info) {
        enviar(res, 404, { erro: "arquivo ou pasta não encontrado" });
        return true;
      }
      if (info.isDirectory()) {
        await rm(alvo, { recursive: true, force: true });
      } else {
        await unlink(alvo);
      }
      enviar(res, 200, { ok: true, path: pathParam });
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else {
        enviar(res, 500, { erro: `erro ao excluir: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
    }
    return true;
  }

  // ── 7. POST /files/rename — renomeia ou move arquivo/pasta
  if (rota === "/files/rename" && req.method === "POST") {
    const ws = await resolverWs(url);
    const wsPath = extrairPathWorkspace(ws);
    const corpo = (await lerCorpo(req)) as { antigo?: string; novo?: string };
    const antigoParam = String(corpo.antigo ?? "").trim();
    const novoParam = String(corpo.novo ?? "").trim();
    if (!antigoParam || !novoParam) {
      enviar(res, 400, { erro: "caminho antigo e novo são obrigatórios" });
      return true;
    }
    try {
      const alvoAntigo = await resolverCaminhoWorkspace(wsPath, antigoParam);
      const alvoNovo = await resolverCaminhoWorkspace(wsPath, novoParam);
      await mkdir(dirname(alvoNovo), { recursive: true });
      await rename(alvoAntigo, alvoNovo);
      enviar(res, 200, { ok: true, antigo: antigoParam, novo: novoParam });
    } catch (erro) {
      if (erro instanceof WorkspaceError && erro.exitCode === 3) {
        enviar(res, 403, { erro: "caminho fora do workspace (path traversal bloqueado)" });
      } else {
        enviar(res, 500, { erro: `erro ao renomear: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
    }
    return true;
  }

  return false;
}
