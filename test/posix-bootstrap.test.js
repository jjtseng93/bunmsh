import { test, expect } from "bun:test";
import { createState, execute, finishShell } from "../src/shell.js";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const decode = (value) => new TextDecoder().decode(value);
async function run(source) {
  const state = createState();
  const value = await execute(source, state, {capture:true});
  const final = await finishShell(state,state.exitRequested ? state.exitStatus : value.status,{capture:true});
  return {status:final.status, stdout:decode(value.stdout)+decode(final.stdout), stderr:decode(value.stderr)+decode(final.stderr), state};
}
test("POSIX function bodies allow inline and newline opening braces", async () => {
  const r = await run('a () { echo a; }\nb ()\n{\n a\n}\nb');
  expect(r.stdout).toBe('a\n'); expect(r.stderr).toBe(''); expect(r.status).toBe(0);
});
test("return crosses conditionals and restores function arguments", async () => {
  const r = await run('f () { if true; then echo "$1"; return 7; fi; echo BAD; }\nset -- outer\nf inner\necho "$? $1"');
  expect(r.stdout).toBe('inner\n7 outer\n'); expect(r.stderr).toBe('');
});
test("break and continue unwind exactly the requested loop levels", async () => {
  const r = await run('for i in a b; do for j in 1 2; do echo "$i$j"; continue 2; done; echo BAD; done\nfor i in a b; do for j in 1 2; do echo "$i$j"; break 2; done; echo BAD; done\necho done');
  expect(r.stdout).toBe('a1\nb1\na1\ndone\n'); expect(r.stderr).toBe('');
});
test("brace groups preserve state and stream into a pipeline", async () => {
  const r = await run('{ x=kept; }\necho "$x"\n{ echo a; echo b; } | cat');
  expect(r.stdout).toBe('kept\na\nb\n'); expect(r.stderr).toBe('');
});
test("groups short circuit and preserve variable changes through redirects", async () => {
  const r = await run('false && { echo BAD; }\ntrue && { x=yes; }\n{ { echo hidden; } >/dev/null; x=kept; }\necho "$x"');
  expect(r.stdout).toBe('kept\n'); expect(r.stderr).toBe('');
});
test("persistent descriptors duplicate, close, and restore command redirects", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-fds-'));
  try {
    const log = join(dir,'log');
    const r = await run(`exec 5>'${log}'\necho first >&5\n{ echo second; x=kept; } >&5\necho "$x"\nexec 6>&5\nexec 5>&-\necho third >&6\nexec 6>&-`);
    expect(r.stdout).toBe('kept\n'); expect(r.stderr).toBe('');
    expect(readFileSync(log,'utf8')).toBe('first\nsecond\nthird\n');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("redirect order snapshots the original stdout and truncates null commands", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-io-order-'));
  try {
    const path = join(dir,'out');
    const cmd = `'${process.execPath}' -e 'console.log("out");console.error("err")'`;
    let r = await run(`${cmd} 2>&1 >'${path}'`);
    expect(r.stdout).toBe('err\n'); expect(r.stderr).toBe('');
    expect(readFileSync(path,'utf8')).toBe('out\n');
    r = await run(`${cmd} >'${path}' 2>&1`);
    expect(r.stdout).toBe(''); expect(r.stderr).toBe('');
    expect(readFileSync(path,'utf8')).toBe('out\nerr\n');
    await run(`>'${path}'`);
    expect(readFileSync(path,'utf8')).toBe('');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("errexit is suppressed in conditions, negation and tested functions", async () => {
  let r = await run('set -e\nfalse\necho BAD');
  expect(r.status).toBe(1); expect(r.stdout).toBe('');
  r = await run('set -e\nf () { false; echo allowed; }\nif f; then echo yes; fi\nfalse && echo BAD\n! true\necho done');
  expect(r.stdout).toBe('allowed\nyes\ndone\n'); expect(r.stderr).toBe('');
  r = await run('set -e\nf () { false; echo BAD; }\nf\necho BAD');
  expect(r.stdout).toBe(''); expect(r.status).toBe(1);
});
test("EXIT traps preserve status, run once, and allow an explicit override", async () => {
  let r = await run("trap 'echo status=$?' 0\nexit 7");
  expect(r.stdout).toBe('status=7\n'); expect(r.status).toBe(7);
  r = await run("trap 'echo once; exit 9' EXIT\nexit 7");
  expect(r.stdout).toBe('once\n'); expect(r.status).toBe(9);
  r = await run("trap 'echo BAD' 0\ntrap - 0\necho ok");
  expect(r.stdout).toBe('ok\n'); expect(r.stderr).toBe('');
});
test("source returns without exiting its caller", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-source-return-'));
  try {
    const path=join(dir,'source'); writeFileSync(path,'echo "$1"\nreturn 8\necho BAD\n');
    const r=await run(`set -- outer\n. '${path}' inner\necho "$? $1"`);
    expect(r.stdout).toBe('inner\n8 outer\n'); expect(r.stderr).toBe('');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("descriptor inheritance reaches external children and subshells", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-inherit-'));
  try {
    const path=join(dir,'log');
    const r=await run(`exec 5>'${path}'\n'${process.execPath}' -e 'require("fs").writeSync(5,"external\\n")'\n(echo subshell >&5)\necho done`);
    expect(r.stdout).toBe('done\n'); expect(r.stderr).toBe('');
    expect(readFileSync(path,'utf8')).toBe('external\nsubshell\n');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("signal traps defer execution and preserve the interrupted status", async () => {
  const state = createState();
  const before=process.listenerCount('SIGUSR1');
  try {
    await execute("trap 'echo caught=$?' USR1",state,{capture:true});
    state.lastStatus=7;
    process.emit('SIGUSR1');
    expect(state.lastStatus).toBe(7);
    const r=await execute('echo after=$?',state,{capture:true});
    expect(decode(r.stdout)).toBe('caught=7\nafter=7\n');
  } finally { await finishShell(state,0,{capture:true}); }
  expect(process.listenerCount('SIGUSR1')).toBe(before);
});
test("noglob and nounset preserve explicit parameter defaults", async () => {
  let r = await run('set -f\necho *\nset -u\necho "${BOOTSTRAP_UNSET_TEST-default}"\necho "$BOOTSTRAP_UNSET_TEST"\necho BAD');
  expect(r.stdout).toBe('*\ndefault\n'); expect(r.status).toBe(1);
  expect(r.stderr).toContain('parameter not set');
});
test("background registry keeps original objects and completed indices", async () => {
  const previous=Bun.sha.procs;
  Bun.sha.procs=[];
  try {
    const r=await run(`'${process.execPath}' -e 'await Bun.sleep(40)' &`);
    expect(r.status).toBe(0);
    const proc=Bun.sha.procs[0];
    expect(typeof proc.kill).toBe('function');
    await proc.exited;
    await run(`'${process.execPath}' -e 'await Bun.sleep(40)' &`);
    expect(Bun.sha.procs).toHaveLength(2);
    expect(Bun.sha.procs[0]).toBe(proc);
    await Bun.sha.procs[1].exited;
  } finally { Bun.sha.procs=previous; }
});
test("redirected compound pipelines keep their streams and variable scope", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-group-pipe-'));
  try {
    const path=join(dir,'out');
    const r=await run(`{ printf hello | cat; x=kept; } >'${path}'\necho "$x"\ncat '${path}'\n(cat '${path}') >'${path}.copy'`);
    expect(r.stdout).toBe('kept\nhello'); expect(r.stderr).toBe('');
    expect(readFileSync(path+'.copy','utf8')).toBe('hello');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("multiline pipelines and Autoconf-shaped nested groups parse completely", async () => {
  const r=await run('case arm in arm)\n{ x=ok\n { { echo "$x"; } >/dev/null\n echo kept; }; }\n;; esac\necho pipe |\ncat');
  expect(r.stdout).toBe('kept\npipe\n'); expect(r.stderr).toBe('');
});
test("exec can retain a descriptor from a temporarily redirected group", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-retained-fd-'));
  try {
    const path=join(dir,'out');
    const r=await run(`{ exec 6>&1; echo inside; } >'${path}'\necho outside >&6\necho terminal`);
    expect(r.stdout).toBe('terminal\n'); expect(r.stderr).toBe('');
    expect(readFileSync(path,'utf8')).toBe('inside\noutside\n');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("fd numbers are recognized only at unquoted token boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(),'bunmsh-io-number-'));
  try {
    const path=join(dir,'out');
    const r=await run(`echo word2>'${path}'\ncat '${path}'`);
    expect(r.stdout).toBe('word2\n'); expect(r.stderr).toBe('');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
