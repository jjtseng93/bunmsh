import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, decode, execute } from "../src/shell.js";

const root = new URL("..", import.meta.url).pathname;
const bunmsh = [process.execPath, "src/main.js", "-c"];

async function invoke(argv, source, env = process.env, args = []) {
  const proc = Bun.spawn([...argv, source, ...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

async function expectLikeSh(source, env, args) {
  const [actual, reference] = await Promise.all([
    invoke(bunmsh, source, env, args),
    invoke(["/bin/sh", "-c"], source, env, args),
  ]);
  expect(actual).toEqual(reference);
}

async function invokeInternal(source, options = {}) {
  const state = createState(options);
  const output = await execute(source, state, { capture: true });
  return {
    status: output.status,
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
  };
}

describe("/bin/sh reference", () => {
  describe("quote and word expansion", () => {
    test("preserves quoted fields and removes quote syntax", async () => {
      await expectLikeSh("value='a b'; /usr/bin/printf '<%s>\\n' \"$value\" '$value' a\\ b");
    });

    test("splits unquoted expansions using IFS", async () => {
      await expectLikeSh("value='one two  three'; /usr/bin/printf '<%s>\\n' $value");
    });

    test("does not apply IFS splitting to literal parts of a word", async () => {
      await expectLikeSh(
        "IFS=:; value='one:two'; /usr/bin/printf '<%s>\\n' $value literal:field",
      );
    });

    test("preserves empty fields from non-whitespace IFS delimiters", async () => {
      await expectLikeSh("IFS=:; value=':a::b:'; /usr/bin/printf '<%s>\\n' $value");
    });

    test("supports parameter defaults, alternatives, lengths, and trimming", async () => {
      await expectLikeSh(
        "value=abc.txt; empty=; /usr/bin/printf '%s\\n' ${missing:-fallback} ${empty:-fallback} " +
          "${value:+present} ${#value} ${value%.txt}",
      );
    });

    test("keeps spaces and nested expansions inside parameter operands", async () => {
      await expectLikeSh(
        "fallback=inside; /usr/bin/printf '<%s>\\n' \"${missing:-two words}\" " +
          "\"${missing:-${fallback}}\"",
      );
    });

    test("performs command substitution and strips trailing newlines", async () => {
      await expectLikeSh("/usr/bin/printf '<%s>\\n' \"$(printf 'a b\\n\\n')\"");
    });

    test("supports legacy backtick substitution", async () => {
      await expectLikeSh("/usr/bin/printf '<%s>\\n' \"`echo legacy`\"");
    });

    test("uses command substitution status for assignment-only commands", async () => {
      await expectLikeSh("value=$(false); echo $?");
    });

    test("performs arithmetic expansion with shell variables", async () => {
      await expectLikeSh("number=6; /usr/bin/printf '%s\\n' $((number * 7 + 1))");
    });

    test("expands quoted and unquoted positional parameters", async () => {
      await expectLikeSh(
        "/usr/bin/printf '<%s>\\n' \"$@\"; /usr/bin/printf '[%s]\\n' $@",
        process.env,
        ["reference", "a b", "c"],
      );
    });

    test("performs pathname generation but preserves quoted patterns", async () => {
      await expectLikeSh(
        "/usr/bin/printf '<%s>\\n' test/reference-*.sh 'test/reference-*.sh' test/no-match-*.none",
      );
    });

    test("expands tilde in words and assignment values", async () => {
      await expectLikeSh("path=~/folder; /usr/bin/printf '%s\\n' ~ \"$path\"");
    });
  });

  describe("command", () => {
    test("executes a utility and preserves its status", async () => {
      await expectLikeSh(
        "command echo hello; command false || echo fallback; command true && echo success",
      );
    });

    test("with no operand succeeds without output", async () => {
      await expectLikeSh("command");
    });

    test("-v reports successful and failed lookup through its status", async () => {
      await expectLikeSh(
        "command -v command >/dev/null && echo found; " +
          "command -v bunmsh-command-that-does-not-exist >/dev/null || echo missing",
      );
    });

    test("-p executes through the default utility PATH", async () => {
      await expectLikeSh("PATH=/no/such/path command -p sh -c 'printf default-path'");
    });
  });

  describe("state and evaluation builtins", () => {
    test("alias definitions expand and unalias removes them", async () => {
      await expectLikeSh(
        "alias greeting='echo hello'\ngreeting\nunalias greeting\n" +
          "alias greeting >/dev/null 2>/dev/null || echo removed",
      );
    });

    test("readonly defines values and lists marked names", async () => {
      await expectLikeSh(
        "readonly BUNMSH_REFERENCE_VALUE=locked; echo $BUNMSH_REFERENCE_VALUE; " +
          "readonly -p | grep BUNMSH_REFERENCE_VALUE >/dev/null && echo readonly",
      );
    });

    test("eval parses and executes its joined arguments", async () => {
      await expectLikeSh("word=works; eval 'echo eval-$word'");
    });

    test("dot sources a file in the current shell", async () => {
      await expectLikeSh(
        "BUNMSH_REFERENCE_SOURCE=value; . ./test/reference-source.sh; echo after:$?",
      );
    });

    test("shift updates positional parameters", async () => {
      await expectLikeSh("shift 2; echo $#:$1", process.env, ["reference", "a", "b", "c"]);
    });
  });

  describe("query and system builtins", () => {
    test("basename handles an optional suffix", async () => {
      await expectLikeSh("basename /usr/src/shell.js .js");
    });

    test("dirname returns the containing path", async () => {
      await expectLikeSh("dirname /usr/src/shell.js");
    });

    test("which searches PATH using Bun.which semantics", async () => {
      const output = await invoke(bunmsh, "which sh; which bunmsh-command-that-does-not-exist");
      expect(output).toEqual({
        status: 1,
        stdout: `${Bun.which("sh", { PATH: process.env.PATH, cwd: root })}\n`,
        stderr: "",
      });
    });

    test("test and [ evaluate files, strings, and integers", async () => {
      await expectLikeSh(
        "test -d . && echo directory; test -n value && echo string; " +
          "[ 7 -ge 3 ] && echo integer; [ missing = present ] || echo unequal",
      );
    });

    test("type reports lookup success through status", async () => {
      await expectLikeSh(
        "type echo >/dev/null && echo builtin; " +
          "type bunmsh-command-that-does-not-exist >/dev/null 2>/dev/null || echo missing",
      );
    });

    test("realpath resolves existing paths", async () => {
      await expectLikeSh("realpath .");
    });

    test("umask reads and changes the process mask", async () => {
      await expectLikeSh("umask 027; umask");
    });

    test("getopts consumes options and option arguments", async () => {
      await expectLikeSh(
        "OPTIND=1; getopts ab: option -a -b value; echo $option:$OPTIND; " +
          "getopts ab: option -a -b value; echo $option:$OPTARG:$OPTIND",
      );
    });

    test("kill -0 checks the current process without sending a signal", async () => {
      await expectLikeSh("kill -0 $$; echo $?");
    });
  });
});

describe("command mksh extensions", () => {
  test("PATH overrides fallback builtins, while builtin selects them explicitly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bunmsh-fallback-"));
    const executable = join(directory, "basename");
    await Bun.write(executable, "#!/bin/sh\necho external-basename\n");
    chmodSync(executable, 0o755);
    const output = await invoke(
      bunmsh,
      "basename /a/b/file.txt; builtin basename /a/b/file.txt",
      { ...process.env, PATH: directory },
    );
    expect(output).toEqual({
      status: 0,
      stdout: "external-basename\nfile.txt\n",
      stderr: "",
    });
  });

  test("fallback builtins run when PATH has no matching executable", async () => {
    const output = await invoke(
      bunmsh,
      "basename /a/b/file.txt; dirname /a/b/file.txt",
      { ...process.env, PATH: "/no/such/path" },
    );
    expect(output).toEqual({ status: 0, stdout: "file.txt\n/a/b\n", stderr: "" });
  });

  test("time reports elapsed nanosecond timing and preserves command results", async () => {
    const output = await invoke(bunmsh, "time echo timed");
    expect(output.status).toBe(0);
    expect(output.stdout).toBe("timed\n");
    expect(output.stderr).toMatch(/^real \d+\.\d{6} ms\n$/);

    const failure = await invoke(bunmsh, "time false");
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toMatch(/^real \d+\.\d{6} ms\n$/);
  });

  test("performs mksh brace expansion", async () => {
    const output = await invoke(bunmsh, "/usr/bin/printf '<%s>\\n' pre{one,two}post");
    expect(output).toEqual({
      status: 0,
      stdout: "<preonepost>\n<pretwopost>\n",
      stderr: "",
    });
  });

  test("performs mksh parameter replacement", async () => {
    const output = await invoke(
      bunmsh,
      "value=one-two-two; echo ${value/two/2}; echo ${value//two/2}",
    );
    expect(output).toEqual({
      status: 0,
      stdout: "one-2-two\none-2-2\n",
      stderr: "",
    });
  });

  test("quoted command names suppress alias expansion", async () => {
    const output = await invokeInternal("'echo' hello", { aliases: { echo: ["false"] } });
    expect(output).toEqual({ status: 0, stdout: "hello\n", stderr: "" });
  });

  test("bypasses aliases while retaining builtins", async () => {
    const output = await invokeInternal("command echo hello", {
      aliases: { echo: ["false"] },
    });
    expect(output).toEqual({ status: 0, stdout: "hello\n", stderr: "" });
  });

  test("-V describes aliases and builtins", async () => {
    const output = await invoke(bunmsh, "command -V ls command");
    expect(output).toEqual({
      status: 0,
      stdout: "ls is an alias for 'ls --color=auto'\ncommand is a shell builtin\n",
      stderr: "",
    });
  });

  test("whence and builtin expose mksh-style lookup", async () => {
    const output = await invoke(bunmsh, "whence echo; builtin echo builtin-ok");
    expect(output).toEqual({ status: 0, stdout: "echo\nbuiltin-ok\n", stderr: "" });
  });

  test("standalone builtin lists registered builtin names", async () => {
    const output = await invoke(bunmsh, "builtin");
    expect(output.status).toBe(0);
    expect(output.stderr).toBe("");
    const names = output.stdout.trimEnd().split("\n");
    expect(names).toEqual([...names].sort());
    expect(names).toContain("builtin");
    expect(names).toContain("command");
    expect(names).toContain("..");
    expect(names).toContain("//");
  });
});
