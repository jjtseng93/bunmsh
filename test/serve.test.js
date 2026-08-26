import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { main as startFileServer } from "../serve.js";

const cwd = join(import.meta.dir, "serve");
let previousPort;
let server;

beforeAll(() => {
  previousPort = process.env.PORT;
  process.env.PORT = "0";
  server = startFileServer(cwd);
});

afterAll(() => {
  server?.stop(true);
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});

test("serve exposes linked Markdown and parser previews", async () => {
  const index = await fetch(server.url).then((response) => response.text());
  expect(index).toContain('href="README.md-bun.markdown.html"');
  expect(index).toContain('href="data.json-json.parse"');
  expect(index).toContain('href="data.json5-bun.json5.parse"');
  expect(index).toContain("🔍");
  if (typeof Bun.XML?.parse === "function") {
    expect(index).toContain('href="data.xml-bun.xml.parse"');
    const xml = await fetch(new URL("data.xml-bun.xml.parse", server.url));
    expect(xml.status).toBe(200);
    expect(await xml.text()).toContain("xml");
  } else {
    expect(index).not.toContain('href="data.xml-bun.xml.parse"');
  }

  const markdown = await fetch(new URL("README.md-bun.markdown.html", server.url));
  expect(markdown.status).toBe(200);
  expect(await markdown.text()).toContain("<strong>Bun</strong>");

  const previews = [
    ["data.json-json.parse", '"name": "json"'],
    ["data.json5-bun.json5.parse", '"name": "json5"'],
    ["data.jsonc-bun.jsonc.parse", '"name": "jsonc"'],
    ["data.jsonl-bun.jsonl.parse", '"line": 2'],
    ["data.ndjson-bun.jsonl.parse", '"line": 3'],
    ["data.yaml-bun.yaml.parse", '"name": "yaml"'],
    ["data.yml-bun.yaml.parse", '"name": "yml"'],
    ["data.toml-bun.toml.parse", '"name": "toml"'],
  ];
  for (const [path, expected] of previews) {
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(expected.replaceAll('"', "&quot;"));
  }

  expect((await fetch(new URL("bad.json-json.parse", server.url))).status).toBe(422);
});

test("serve keeps native HTTP Range handling on original files", async () => {
  const response = await fetch(new URL("README.md", server.url), {
    headers: { range: "bytes=0-8" },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 0-8/26");
  expect(await response.text()).toBe("# Preview");
});
