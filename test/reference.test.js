import { describe, expect, test } from "bun:test";
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
});
