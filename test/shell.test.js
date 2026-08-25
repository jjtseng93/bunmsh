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
