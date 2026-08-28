import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorJson, main, renderFancy } from "../src/cat-fancy.js";

describe("catfancy", () => {
  test("parses data formats into colored pretty JSON", () => {
    for (const [name, source] of [
      ["data.json", '{"name":"bun","count":2}'],
      ["data.json5", "{name: 'bun', count: 2}"],
      ["data.toml", 'name = "bun"\ncount = 2\n'],
    ]) {
      const output = renderFancy(source, name);
      expect(output).toContain("\x1b[38;2;");
      expect(Bun.stripANSI(output)).toBe('{\n  "name": "bun",\n  "count": 2\n}\n');
    }
  });

  test("uses Bun markdown ANSI rendering with hyperlinks", () => {
    const output = renderFancy("# Docs\n\n[Site](https://example.com)\n", "README.md");
    expect(output).toContain("\x1b]8;;https://example.com");
    expect(Bun.stripANSI(output)).toContain("Docs");
  });

  test("leaves files without a preview format unchanged", () => {
    expect(renderFancy("plain text\n", "notes.txt")).toBe("plain text\n");
  });

  test("reads files relative to cwd and reports parser errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-catfancy-"));
    try {
      await Bun.write(join(directory, "data.toml"), 'enabled = true\n');
      await Bun.write(join(directory, "bad.json"), "{");
      const good = await main(["catfancy", "data.toml"], directory);
      expect(good.status).toBe(0);
      expect(Bun.stripANSI(good.stdout)).toBe('{\n  "enabled": true\n}\n');
      const excluded = await main([
        "catfancy", "--exclude", "*.json", "bad.json", "data.toml",
      ], directory);
      expect(excluded.status).toBe(0);
      expect(Bun.stripANSI(excluded.stdout)).toBe('{\n  "enabled": true\n}\n');
      const bad = await main(["catfancy", "bad.json"], directory);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("bunmsh: catfancy: bad.json:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("colors JSON keys, strings, numbers, and constants", () => {
    const output = colorJson('{"key":"value","n":1,"ok":true}');
    expect((output.match(/\x1b\[38;2;/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(Bun.stripANSI(output)).toBe('{"key":"value","n":1,"ok":true}');
  });
});
