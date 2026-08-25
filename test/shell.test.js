import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunShellFallbackArgv,
  createState,
  decode,
  execute,
  parse,
  tokenize,
} from "../src/shell.js";
import {
  CommandIndex,
  FileIndex,
  completionContext,
  firstPrefixMatch,
  historyGhost,
  nextGhostChunk,
  prefixMatches,
} from "../src/completion.js";
import { isLinkerPath } from "../single-exe/compiled.js";

async function run(source, options = {}) {
  const state = createState({
    env: { HOME: "/tmp", ...options.env },
    cwd: options.cwd ?? process.cwd(),
    args: options.args ?? ["bunmsh"],
  });
  const output = await execute(source, state, { capture: true });
  return {
    ...output,
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
    state,
  };
}

describe("parser", () => {
  test("recognizes supported ELF and Android dynamic linker names", () => {
    expect(isLinkerPath("/lib/ld-linux-aarch64.so.1")).toBe(true);
    expect(isLinkerPath("/lib/ld-musl-x86_64.so.1")).toBe(true);
    expect(isLinkerPath("/system/bin/linker64")).toBe(true);
    expect(isLinkerPath("/system/bin/linker")).toBe(true);
    expect(isLinkerPath("/usr/bin/ld")).toBe(false);
    expect(isLinkerPath("/usr/bin/bun")).toBe(false);
  });

  test("tokenizes quotes and operators", () => {
    const tokens = tokenize(`echo "a b" | cat && print ok`);
    expect(tokens.filter((token) => token.type === "op").map((token) => token.value))
      .toEqual(["|", "&&"]);
  });

  test("parses a pipeline", () => {
    expect(parse("echo hi | tr a-z A-Z")[0].pipeline).toHaveLength(2);
  });
});

describe("completion", () => {
  test("finds prefix ranges in a sorted command index", () => {
    const names = ["bun", "bunx", "cat", "git"];
    expect(prefixMatches(names, "bu")).toEqual(["bun", "bunx"]);
    expect(firstPrefixMatch(names, "gi")).toBe("git");
    expect(prefixMatches(names, "")).toEqual([]);
  });

  test("recognizes command positions after assignments and operators", () => {
    expect(completionContext("bu")).toMatchObject({ command: true, prefix: "bu" });
    expect(completionContext("X=1 bu")).toMatchObject({ command: true, prefix: "bu" });
    expect(completionContext("echo hi | gr")).toMatchObject({ command: true, prefix: "gr" });
    expect(completionContext("echo bu")).toMatchObject({ command: false, prefix: "bu" });
    expect(completionContext("echo ")).toMatchObject({ command: false, prefix: "" });
  });

  test("uses recent history for ghosts and accepts one word at a time", () => {
    const history = ["git status", "git log --oneline", "git status --short"];
    expect(historyGhost(history, "git status")).toBe(" --short");
    expect(nextGhostChunk(" --short branch")).toBe(" --short ");
    expect(nextGhostChunk("branch")).toBe("branch");
  });

  test("indexes PATH names without checking executable permission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-completion-"));
    try {
      await Bun.write(`${directory}/alpha`, "not executable");
      await Bun.write(`${directory}/alpine`, "also not executable");
      const index = new CommandIndex(["alias"]);
      await index.refresh({ cwd: process.cwd(), env: { PATH: directory }, aliases: {} });
      expect(index.matches("al")).toEqual(["alias", "alpha", "alpine"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the platform PATH delimiter and hides Windows executable extensions", async () => {
    const first = mkdtempSync(join(tmpdir(), "bunmsh-win-path-a-"));
    const second = mkdtempSync(join(tmpdir(), "bunmsh-win-path-b-"));
    try {
      await Bun.write(`${first}/Alpha.EXE`, "exe");
      await Bun.write(`${first}/ignored.txt`, "text");
      await Bun.write(`${second}/beta.cmd`, "cmd");
      await Bun.write(`${second}/gamma.bat`, "bat");
      const index = new CommandIndex([], { platform: "win32", pathDelimiter: ";" });
      await index.refresh({
        cwd: process.cwd(),
        env: { PATH: `${first};${second}` },
        aliases: {},
      });
      expect(index.matches("A")).toEqual(["Alpha"]);
      expect(index.matches("b")).toEqual(["beta"]);
      expect(index.matches("g")).toEqual(["gamma"]);
      expect(index.matches("i")).toEqual([]);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("suggests files and marks directories with a trailing slash", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-files-"));
    try {
      await Bun.write(`${directory}/alpha.txt`, "alpha");
      mkdirSync(`${directory}/alpine`);
      const index = new FileIndex();
      const state = { cwd: directory, env: {} };
      expect(index.matches("", state)).toEqual(["alpha.txt", "alpine/"]);
      expect(index.matches("al", state)).toEqual(["alpha.txt", "alpine/"]);
      expect(index.first("alpha", state)).toBe("alpha.txt");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("execution", () => {
  test("normalizes Bun Shell cp recursion and provides a PATH-independent cat", async () => {
    expect(bunShellFallbackArgv(["cp", "-rv", "a", "b"]))
      .toEqual(["cp", "-Rv", "a", "b"]);
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-cat-"));
    try {
      await Bun.write(`${directory}/a.txt`, "alpha");
      await Bun.write(`${directory}/b.txt`, "beta");
      const output = await run("cat a.txt b.txt", {
        cwd: directory,
        env: { PATH: "/no/such/path" },
      });
      expect(output).toMatchObject({ status: 0, stdout: "alphabeta", stderr: "" });
      mkdirSync(`${directory}/source`);
      await Bun.write(`${directory}/source/item.txt`, "copied");
      const copied = await run("cp -r source target", {
        cwd: directory,
        env: { PATH: "/no/such/path" },
      });
      expect(copied).toMatchObject({ status: 0, stdout: "", stderr: "" });
      expect(await Bun.file(`${directory}/target/item.txt`).text()).toBe("copied");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("provides basic fallback text and utility commands", async () => {
    expect(await run("printf 'c\\na\\nb\\n' | builtin sort")).toMatchObject({ stdout: "a\nb\nc\n" });
    expect(await run("printf 'one two\\nthree\\n' | builtin wc -lwc")).toMatchObject({ stdout: "2 3 14\n" });
    expect(await run("printf 'abc\\n' | builtin tr a-z A-Z")).toMatchObject({ stdout: "ABC\n" });
    expect(await run("printf '1\\n2\\n3\\n' | builtin head -n 2")).toMatchObject({ stdout: "1\n2\n" });
    expect(await run("printf '1\\n2\\n3\\n' | builtin tail -n 2")).toMatchObject({ stdout: "2\n3\n" });
    expect(await run("builtin date +%F")).toMatchObject({ status: 0 });
    expect(await run("builtin sleep 1ms")).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  test("fallback grep supports matching, output modes, quiet, and recursion", async () => {
    expect(await run("printf 'Alpha beta\\nnone\\nBETA\\n' | builtin grep -Ein 'beta'"))
      .toMatchObject({ status: 0, stdout: "1:Alpha beta\n3:BETA\n" });
    expect(await run("printf 'abc123\\n' | builtin grep -Eo '[0-9]+'"))
      .toMatchObject({ status: 0, stdout: "123\n" });
    expect(await run("printf 'keep\\ndrop\\n' | builtin grep -v drop"))
      .toMatchObject({ status: 0, stdout: "keep\n" });
    expect(await run("printf 'found\\n' | builtin grep -q found"))
      .toMatchObject({ status: 0, stdout: "" });
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-grep-"));
    try {
      mkdirSync(`${directory}/nested`);
      await Bun.write(`${directory}/nested/a.txt`, "needle\n");
      const recursive = await run("builtin grep -rn needle nested", { cwd: directory });
      expect(recursive).toMatchObject({ status: 0, stdout: "nested/a.txt:1:needle\n" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("fallback head closes an infinite upstream and file utilities work", async () => {
    expect(await run("yes | builtin head -n 2")).toMatchObject({ status: 0, stdout: "y\ny\n" });
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-utils-"));
    try {
      const tee = await run("printf data | builtin tee saved.txt", { cwd: directory });
      expect(tee).toMatchObject({ status: 0, stdout: "data" });
      expect(await Bun.file(`${directory}/saved.txt`).text()).toBe("data");
      const md5 = await run("builtin md5sum saved.txt", { cwd: directory });
      expect(md5.stdout).toBe("8d777f385d3dfec8815d20f7496026dc  saved.txt\n");
      const sha = await run("builtin sha256sum saved.txt", { cwd: directory });
      expect(sha.stdout).toBe("3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7  saved.txt\n");
      const temporary = await run("builtin mktemp -d sample.XXXXXX", { cwd: directory });
      const created = temporary.stdout.trim();
      expect(created.startsWith(`${directory}/sample.`)).toBe(true);
      expect(await run(`builtin rmdir ${created}`, { cwd: directory })).toMatchObject({ status: 0 });
      expect(await Bun.file(created).exists()).toBe(false);
      expect(await run("builtin clear")).toMatchObject({ stdout: "\x1b[2J\x1b[H" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("reflects bunmsh and process.argv0 through fallback commands", async () => {
    const nested = await run("bunmsh -cc printf nested", { env: { PATH: "/no/such/path" } });
    expect(nested).toMatchObject({ status: 0, stdout: "nested", stderr: "" });
    const runtime = await run("bun --version", { env: { PATH: "/no/such/path" } });
    expect(runtime).toMatchObject({ status: 0, stdout: `${Bun.version}\n`, stderr: "" });
  });

  test("env recursively dispatches env commands with isolated assignments", async () => {
    const chained = await run("env env a=1 env b=2");
    expect(chained.status).toBe(0);
    expect(chained.stdout.split("\n")).toContain("a=1");
    expect(chained.stdout.split("\n")).toContain("b=2");
    expect(chained.state.env.a).toBeUndefined();
    expect(chained.state.env.b).toBeUndefined();

    const clean = await run("env -i a=1 env b=2");
    expect(clean.stdout.split("\n").filter(Boolean).sort()).toEqual(["a=1", "b=2"]);
  });

  test("evaluates raw Bun. lines before shell parsing and expansion", async () => {
    const output = await run(`  Bun.version + " $HOME * ; raw"`);
    expect(output.status).toBe(0);
    expect(output.stdout).toBe(`${Bun.version} $HOME * ; raw\n`);
    expect(output.stderr).toBe("");
  });

  test("awaits Bun. eval results, suppresses undefined, and reports errors", async () => {
    const empty = await run("Bun.sleep(0)");
    expect(empty).toMatchObject({ status: 0, stdout: "", stderr: "" });

    const failure = await run("Bun.thisMethodDoesNotExist()");
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("TypeError");
  });

  test("provides color aliases for common commands", () => {
    const state = createState();
    expect(state.aliases).toEqual({
      ls: ["ls", "--color=auto"],
      diff: ["diff", "--color=auto"],
      grep: ["grep", "--color=auto"],
    });
  });

  test("expands variables while respecting single quotes", async () => {
    const output = await run(`X=world; print -r -- "hello $X"; print -r -- '$X'`);
    expect(output.stdout).toBe("hello world\n$X\n");
  });

  test("supports status connectors", async () => {
    const output = await run("false && echo no; false || echo yes; true && echo done");
    expect(output.stdout).toBe("yes\ndone\n");
    expect(output.status).toBe(0);
  });

  test("runs external pipelines through Bun.spawn", async () => {
    const output = await run("printf hello | tr a-z A-Z");
    expect(output.stdout).toBe("HELLO");
    expect(output.stderr).toBe("");
    expect(output.status).toBe(0);
  });

  test("keeps builtin state outside pipelines", async () => {
    const output = await run("export BUNMSH_TEST=value; print -r -- $BUNMSH_TEST");
    expect(output.stdout).toBe("value\n");
    expect(output.state.env.BUNMSH_TEST).toBe("value");
  });

  test("supports cd - and previous-child navigation", async () => {
    const cwd = process.cwd();
    const previous = await run("cd src; cd -; pwd", { cwd });
    expect(previous.stdout).toBe(`${cwd}\n${cwd}\n`);
    expect(previous.state.env.OLDPWD).toBe(`${cwd}/src`);

    const child = await run("cd src; cd ..; //; pwd", { cwd });
    expect(child.stdout).toBe(`${cwd}/src\n`);
    expect(child.state.cwd).toBe(`${cwd}/src`);
  });

  test("treats .. as cd ..", async () => {
    const cwd = process.cwd();
    const output = await run("cd src; ..; pwd", { cwd });
    expect(output.stdout).toBe(`${cwd}\n`);
    expect(output.state.cwd).toBe(cwd);
    expect(output.state.env.OLDPWD).toBe(`${cwd}/src`);
  });

  test("treats standalone - as cd -", async () => {
    const cwd = process.cwd();
    const output = await run("cd src; -; pwd", { cwd });
    expect(output.stdout).toBe(`${cwd}\n${cwd}\n`);
    expect(output.state.cwd).toBe(cwd);
    expect(output.state.env.OLDPWD).toBe(`${cwd}/src`);
  });

  test("treats standalone ~ as cd HOME", async () => {
    const cwd = process.cwd();
    const home = cwd.slice(0, cwd.lastIndexOf("/"));
    const output = await run("cd src; ~; pwd", { cwd, env: { HOME: home } });
    expect(output.stdout).toBe(`${home}\n`);
    expect(output.state.cwd).toBe(home);
    expect(output.state.env.OLDPWD).toBe(`${cwd}/src`);
  });

  test("// reports a missing child and continues", async () => {
    const output = await run("//; print still-running");
    expect(output.stdout).toBe("still-running\n");
    expect(output.stderr).toBe("bunmsh: //: no previous child directory\n");
    expect(output.status).toBe(0);
  });

  test("exposes positional parameters and status", async () => {
    const output = await run("false; print -r -- $0 $1 $# $?", {
      args: ["script", "arg"],
    });
    expect(output.stdout).toBe("script arg 1 1\n");
  });

  test("tab creates cwd-only workspaces and cycles between them", async () => {
    const cwd = process.cwd();
    const output = await run("tab; cd src; tab; pwd; tab; pwd", { cwd });
    expect(output.stdout).toBe(`${cwd}\n${cwd}/src\n`);
    expect(output.state.tabs).toEqual([cwd, `${cwd}/src`]);
    expect(output.state.activeTab).toBe(1);
    expect(output.state.cwd).toBe(`${cwd}/src`);
    expect(output.state.env.OLDPWD).toBe(cwd);
  });

  test("tab supports new, numbered, left, right, and close operations", async () => {
    const cwd = process.cwd();
    const output = await run(
      "tab n; cd src; tab n; cd ../test; tab 1; tab r; pwd; tab l; pwd; " +
        "tab 3; pwd; tab x; pwd",
      { cwd },
    );
    expect(output.stdout).toBe(`${cwd}/src\n${cwd}\n${cwd}/test\n${cwd}/src\n`);
    expect(output.state.tabs).toEqual([cwd, `${cwd}/src`]);
    expect(output.state.activeTab).toBe(1);
    expect(output.state.cwd).toBe(`${cwd}/src`);
  });

  test("tab rejects invalid selection and closing the final tab", async () => {
    const missing = await run("tab 2");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("bunmsh: tab: 2: no such tab\n");

    const last = await run("tab x");
    expect(last.status).toBe(1);
    expect(last.stderr).toBe("bunmsh: tab: cannot close the last tab\n");
  });
});

describe("CLI", () => {
  test("detects highest-priority Bun. lines inside script files", async () => {
    const cwd = new URL("..", import.meta.url).pathname;
    const proc = Bun.spawn([process.execPath, "src/main.js", "test/t.sh"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stdout).toBe(
      `shell-before\n${Bun.version}\n${Math.cos(1)}\n` +
        `{ message: 'shared', count: 1 }\n2\n` +
        `{ message: 'shared', count: 2 }\n` +
        `from command substitution: shared\nshell-after\n`,
    );
    expect(stderr).toBe("");
  });

  test("--readme renders the bundled README and exits", async () => {
    const proc = Bun.spawn([process.execPath, "src/main.js", "--readme"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("bunmsh");
    expect(stdout).toContain("Built-in README");
    expect(stderr).toBe("");
  });

  test("expands \\w in the interactive prompt", async () => {
    const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const home = cwd.slice(0, cwd.lastIndexOf("/"));
    const proc = Bun.spawn([process.execPath, "src/main.js", "-i"], {
      cwd,
      env: { ...process.env, HOME: home, PS1: "[\\w] " },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("exit\n");
    proc.stdin.end();
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stdout).toBe(`[~${cwd.slice(home.length)}] `);
    expect(stderr).toBe("");
  });

  test("shows all tab paths and marks the active tab", async () => {
    const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const home = cwd.slice(0, cwd.lastIndexOf("/"));
    const shown = `~${cwd.slice(home.length)}`;
    const proc = Bun.spawn([process.execPath, "src/main.js", "-i"], {
      cwd,
      env: { ...process.env, HOME: home, PS1: "[\\w] " },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("tab\nexit\n");
    proc.stdin.end();
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stdout).toBe(`[${shown}] [📁 ${shown}  📂 ${shown}] `);
    expect(stderr).toBe("");
  });

  test("adds the active tab number to the default multi-tab prompt", async () => {
    const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const home = cwd.slice(0, cwd.lastIndexOf("/"));
    const shown = `~${cwd.slice(home.length)}`;
    const env = { ...process.env, HOME: home };
    delete env.PS1;
    const proc = Bun.spawn([process.execPath, "src/main.js", "-i"], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("tab\nexit\n");
    proc.stdin.end();
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stdout).toBe(
      `📁 ${shown}\n$ 📁 ${shown}  📂 ${shown}\n[2]$ `,
    );
    expect(stderr).toBe("");
  });

  test("renders ghosts and accepts history words, file paths, and commands", async () => {
    let transcript = "";
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 30,
      data(_terminal, data) { transcript += data.toString(); },
    });
    const proc = Bun.spawn({
      cmd: [Bun.which("bun") || process.argv0, "src/main.js", "-i"],
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PS1: "> " },
      terminal,
    });
    const send = async (text) => {
      terminal.write(text);
      await Bun.sleep(80);
    };
    try {
      await Bun.sleep(150);
      await send("echo hello world\r");
      await send("echo h");
      await send("\x1b[C");
      await send("\r");
      await send("echo h");
      await send("\t");
      await send("\r");
      await send("basename pack");
      await send("\x1b[C");
      await send("\r");
      await send("pri");
      await send("\t");
      await send("\r");
      await send("exit\r");
      expect(await proc.exited).toBe(0);
    } finally {
      terminal.close();
    }
    expect(transcript).toContain("\x1b[2mello world\x1b[0m");
    expect(transcript).toContain("\x1b[2mage.json\x1b[0m");
    expect(transcript).toContain("package.json\r\n");
    expect(transcript).toContain("\x1b[2mnt\x1b[0m");
    expect(transcript).toContain("\x1b[0Knt\r");
  });
});
