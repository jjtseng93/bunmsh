import { describe, expect, test } from "bun:test";
import { createState, decode, execute, parse, tokenize } from "../src/shell.js";

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

describe("execution", () => {
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
});
