#!/usr/bin/env bun

import { lstatSync, readdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { iconFor } from "./src/fancy-ls.js";

let root = process.cwd();

const escapeHtml = (value) => Bun.escapeHTML(value);

const PARSERS = new Map([
  ["json", { name: "json.parse", parse: JSON.parse }],
  ["json5", { name: "bun.json5.parse", parse: Bun.JSON5.parse }],
  ["jsonc", { name: "bun.jsonc.parse", parse: Bun.JSONC.parse }],
  ["jsonl", { name: "bun.jsonl.parse", parse: Bun.JSONL.parse }],
  ["ndjson", { name: "bun.jsonl.parse", parse: Bun.JSONL.parse }],
  ["yaml", { name: "bun.yaml.parse", parse: Bun.YAML.parse }],
  ["yml", { name: "bun.yaml.parse", parse: Bun.YAML.parse }],
  ["toml", { name: "bun.toml.parse", parse: Bun.TOML.parse }],
]);

if (typeof Bun.XML?.parse === "function") {
  PARSERS.set("xml", { name: "bun.xml.parse", parse: Bun.XML.parse });
}

const extension = (name) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const previewName = (name) => extension(name) === "md"
  ? "bun.markdown.html"
  : PARSERS.get(extension(name))?.name;

const page = (title, body) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark }
  body { max-width: 72rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.7 ui-monospace, monospace }
  a { color: inherit; text-decoration: none }
  a:hover { text-decoration: underline }
  pre { padding: 1rem; overflow: auto; white-space: pre-wrap; background: color-mix(in srgb, CanvasText 7%, Canvas) }
  code { font: inherit }
  .json-statement { color: #b0005a }
  .json-string { color: #6b5d00 }
  .json-special { color: #087f5b }
  .json-number, .json-constant { color: #5f3dc4 }
  @media (prefers-color-scheme: dark) {
    .json-statement { color: #f92672 }
    .json-string { color: #e6db74 }
    .json-special { color: #a6e22e }
    .json-number, .json-constant { color: #ae81ff }
  }
</style>
${body}`;

const pretty = (value) => {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? `${item}n` : item, 2) ?? String(value);
  } catch {
    return Bun.inspect(value, { colors: false, depth: Infinity });
  }
};

// Mirrors the useful groups in jsmdcui/runtime/syntax/json.yaml for the
// strict JSON emitted by pretty(): statement keys, strings and escapes,
// numbers, and true/false/null constants.
export const highlightJson = (source) => {
  const input = String(source);
  const token = /"(?:\\(?:u[\da-fA-F]{4}|.)|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let output = "", cursor = 0, match;
  const stringHtml = (value) => {
    let html = "", offset = 0;
    for (const escape of value.matchAll(/\\(?:u[\da-fA-F]{4}|.)/g)) {
      html += escapeHtml(value.slice(offset, escape.index));
      html += `<span class="json-special">${escapeHtml(escape[0])}</span>`;
      offset = escape.index + escape[0].length;
    }
    return html + escapeHtml(value.slice(offset));
  };
  while ((match = token.exec(input))) {
    output += escapeHtml(input.slice(cursor, match.index));
    const value = match[0];
    let end = token.lastIndex;
    if (value.startsWith('"')) {
      const propertyEnd = /^\s*:/.exec(input.slice(end));
      if (propertyEnd) {
        end += propertyEnd[0].length;
        output += `<span class="json-statement">${escapeHtml(input.slice(match.index, end))}</span>`;
      } else {
        output += `<span class="json-string">${stringHtml(value)}</span>`;
      }
    } else if (value === "true" || value === "false" || value === "null") {
      output += `<span class="json-constant">${value}</span>`;
    } else {
      output += `<span class="json-number">${value}</span>`;
    }
    cursor = end;
    token.lastIndex = end;
  }
  return output + escapeHtml(input.slice(cursor));
};

const previewResponse = async (entry) => {
  const kind = extension(entry.name);
  try {
    const source = await Bun.file(entry.path).text();
    if (kind === "md") return new Response(page(entry.name,
      `<p><a href="${encodeURIComponent(entry.name)}">← ${escapeHtml(entry.name)}</a></p>\n${Bun.markdown.html(source)}`), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const parser = PARSERS.get(kind);
    const output = pretty(parser.parse(source));
    return new Response(page(`${entry.name} — ${parser.name}`,
      `<p><a href="${encodeURIComponent(entry.name)}">← ${escapeHtml(entry.name)}</a></p>\n<h1>${escapeHtml(entry.name)}</h1>\n<pre><code>${highlightJson(output)}</code></pre>`), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    return new Response(page(`Cannot preview ${entry.name}`,
      `<h1>Cannot preview ${escapeHtml(entry.name)}</h1>\n<pre>${escapeHtml(error?.stack ?? String(error))}</pre>`), {
      status: 422,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
};

const directoryHtml = (route, entries) => {
  const parent = route === "/" ? "" : `<a href="../">📦 ../</a>\n`;
  const links = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const directory = entry.stats.isDirectory();
      const name = `${entry.name}${directory ? "/" : ""}`;
      const encoded = encodeURIComponent(entry.name);
      const preview = !directory && previewName(entry.name);
      return `<a href="${encoded}${directory ? "/" : ""}">${iconFor(entry.name, entry.stats)} ${escapeHtml(name)}</a>${preview ? `  <a href="${encoded}-${preview}" title="Preview with ${preview}">🔍</a>` : ""}`;
    })
    .join("\n");
  const title = `Index of ${route}`;
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<pre>${parent}${links}${links ? "\n" : ""}</pre>`);
};

const resolveRequestPath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const path = resolve(root, `.${decoded.replaceAll("\\", "/")}`);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    return null;
  return { path, decoded };
};

const previewRequest = (pathname) => {
  const names = ["bun.markdown.html", ...new Set([...PARSERS.values()].map(({ name }) => name))];
  for (const preview of names) {
    const suffix = `-${preview}`;
    if (!pathname.endsWith(suffix)) continue;
    const original = pathname.slice(0, -suffix.length);
    if (previewName(basename(original)) === preview) return original;
  }
  return null;
};

const notFound = () => new Response("Not Found", { status: 404 });

export const resolveBunfsPath = (directory, moduleDirectory = import.meta.dirname) => {
  const requested = String(directory).replaceAll("\\", "/");
  const moduleDir = String(moduleDirectory).replaceAll("\\", "/").replace(/\/$/, "");
  const mount = /^(\/\$bunfs|[a-z]:\/~bun)(?:\/|$)/i.exec(moduleDir)?.[1];
  if (!mount) return null;
  const alias = /^(\/\$bunfs|[a-z]:\/~bun)(?=\/|$)/i.exec(requested)?.[1];
  if (!alias) return null;
  let suffix = requested.slice(alias.length);
  // Accept both the logical-root spelling and Bun's displayed physical
  // spelling without turning .../root/... into .../root/root/....
  if (suffix.toLowerCase() === "/root") suffix = "";
  else if (suffix.toLowerCase().startsWith("/root/")) suffix = suffix.slice(5);
  return `${moduleDir}${suffix}`;
};

const handleRequest = async (request) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });

  const url = new URL(request.url);
  const originalPreviewPath = previewRequest(url.pathname);
  const resolved = resolveRequestPath(originalPreviewPath ?? url.pathname);
  if (!resolved) return new Response("Bad Request", { status: 400 });

  let stats;
  try {
    stats = lstatSync(resolved.path);
  } catch {
    return notFound();
  }

  if (originalPreviewPath) {
    if (stats.isDirectory()) return notFound();
    return previewResponse({ name: basename(resolved.path), path: resolved.path, stats });
  }

  if (stats.isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
      return Response.redirect(url, 308);
    }
    let entries;
    try {
      entries = readdirSync(resolved.path, { withFileTypes: true }).map((entry) => {
        const path = resolve(resolved.path, entry.name);
        return { name: entry.name, path, stats: lstatSync(path) };
      });
    } catch (error) {
      return new Response(`Cannot list directory: ${error.message}`, { status: 403 });
    }
    return new Response(directoryHtml(resolved.decoded, entries), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Keep this as a whole, unsliced Bun.file() response. Bun's normal response
  // path then provides native GET/HEAD Range handling, including 206 and 416.
  return new Response(Bun.file(resolved.path));
};

const safeHandleRequest = async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    // Keep an unexpected renderer, filesystem, or runtime exception local to
    // this request. Bun.serve stays alive and the next request is unaffected.
    console.error("bunmsh: serve: request failed:", error);
    return new Response(page("Internal Server Error",
      "<h1>Internal Server Error</h1>\n<p>The server is still running.</p>"), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
};

export function main(directory = process.argv[2] ?? process.cwd()) {
  // The virtual mount itself is not stat-able. import.meta.dirname points at
  // its real root on each platform: /$bunfs/root or B:/~BUN/root.
  root = resolve(resolveBunfsPath(directory) ?? directory);
  const serverOptions = {
    port: Number(process.env.PORT ?? 3000),
    fetch: safeHandleRequest,
  };
  let server;
  try {
    server = Bun.serve(serverOptions);
  } catch (error) {
    const addressInUse = error?.code === "EADDRINUSE" ||
      /EADDRINUSE|address already in use/i.test(String(error?.message ?? error));
    if (serverOptions.port !== 3000 || !addressInUse) throw error;
    server = Bun.serve({ ...serverOptions, port: 0 });
  }
  console.log(`Serving ${root}\n  ${server.url.href}`);
  return server;
}

export function waitForInterrupt(server) {
  return new Promise((resolve) => {
    let readline;
    let finished = false;
    const stop = (signal) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      readline?.close();
      server.stop(true);
      resolve(signal);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    if (!process.stdin.isTTY) return;
    console.log("q/quit/exit: stop  o: open in browser");
    readline = createInterface({ input: process.stdin, terminal: false });
    readline.on("line", (line) => {
      const command = line.trim().toLowerCase();
      if (["q", "quit", "exit"].includes(command)) {
        stop("QUIT");
      } else if (command === "o") {
        const executable = Bun.which("xdg-open");
        if (!executable) {
          console.error("bunmsh: serve: xdg-open not found");
          return;
        }
        try {
          Bun.spawn([executable, server.url.href], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }).unref();
        } catch (error) {
          console.error(`bunmsh: serve: xdg-open: ${error.message}`);
        }
      } else if (command) {
        console.error(`bunmsh: serve: unknown control: ${command}`);
      }
    });
    readline.on("close", () => stop("EOF"));
  });
}

if (import.meta.main) await waitForInterrupt(main());
