#!/usr/bin/env bun

import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { iconFor } from "./src/fancy-ls.js";

let root = resolve(process.argv[2] ?? ".");

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

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
      return `<a href="${encodeURIComponent(entry.name)}${directory ? "/" : ""}">${iconFor(entry.name, entry.stats)} ${escapeHtml(name)}</a>`;
    })
    .join("\n");
  const title = `Index of ${decodeURIComponent(route)}`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark }
  body { max-width: 72rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.7 ui-monospace, monospace }
  a { color: inherit; text-decoration: none }
  a:hover { text-decoration: underline }
  pre { white-space: pre-wrap }
</style>
<h1>${escapeHtml(title)}</h1>
<pre>${parent}${links}${links ? "\n" : ""}</pre>`;
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
      else routes[routePath(entry.path)] = new Response(Bun.file(entry.path));
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
  console.log(`Serving ${root}\n${server.url.href}`);
  return server;
}

export function waitForInterrupt(server) {
  return new Promise((resolve) => {
    const stop = (signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.stop();
      resolve(signal);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.main) await waitForInterrupt(main());
