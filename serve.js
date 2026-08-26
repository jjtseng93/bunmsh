#!/usr/bin/env bun

import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { iconFor } from "./src/fancy-ls.js";

let root = resolve(process.argv[2] ?? ".");

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

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
      `<p><a href="${encodeURIComponent(entry.name)}">← ${escapeHtml(entry.name)}</a></p>\n<h1>${escapeHtml(entry.name)}</h1>\n<pre><code>${escapeHtml(output)}</code></pre>`), {
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

const routePath = (path, directory = false) => {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const route = `/${relativePath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  return directory && route !== "/" ? `${route}/` : route;
};

const directoryHtml = (path, entries) => {
  const route = routePath(path, true);
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
  const title = `Index of ${decodeURIComponent(route)}`;
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<pre>${parent}${links}${links ? "\n" : ""}</pre>`);
};

export function main(directory = process.argv[2] ?? process.cwd()) {
  root = resolve(directory);
  const routes = Object.create(null);
  const visit = (path) => {
    const entries = readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      path: resolve(path, entry.name),
      stats: lstatSync(resolve(path, entry.name)),
    }));
    const route = routePath(path, true);
    const html = directoryHtml(path, entries);
    routes[route] = () => new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    if (route !== "/") routes[route.slice(0, -1)] = (request) =>
      Response.redirect(new URL(`${new URL(request.url).pathname}/`, request.url), 308);
    for (const entry of entries) {
      if (entry.stats.isDirectory()) visit(entry.path);
      else {
        const fileRoute = routePath(entry.path);
        routes[fileRoute] = new Response(Bun.file(entry.path));
        const preview = previewName(entry.name);
        if (preview) routes[`${fileRoute}-${preview}`] = () => previewResponse(entry);
      }
    }
  };

  visit(root);
  const serverOptions = {
    port: Number(process.env.PORT ?? 3000),
    routes,
    fetch: () => new Response("Not Found", { status: 404 }),
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
