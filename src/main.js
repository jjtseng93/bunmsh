#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { createState, execute } from "./shell.js";
import { readAssetText } from "../single-exe/assetsHelper.js";
import { buildEarlyExit } from "../single-exe/compiled.js";
import pkg from "../package.json" with { type:"json" }

const VERSION = `
${pkg.name}: ${pkg.description}
(mksh-inspired Bun Modern Shell)
  Made by: Dr. John (醫者小智)

Version: ${pkg.version} 
`

async function printReadme() {
  const source = await readAssetText("README.md");
  console.log(
    Bun.markdown?.ansi(source, { hyperlinks: true }) || source,
  );
}

function usage() {
  console.log(`
Usage:
  bunmsh
  bunmsh [options] [script [arguments...]]
  bunmsh -c command [name [arguments...]]

Options:
  -c command   Execute command text
  -i           Enter interactive mode
  -h, --help   Show this help
  -V, --version
               Show version
  --readme     Show bunmsh's README.md
  --build-exe  Build ./bmsh for the current platform
  --build-for TARGET
               Cross-compile ./bmsh for TARGET
`);
}

function renderPrompt(state) {
  const rawHome = state.env.HOME;
  const home = rawHome === "/" ? "/" : rawHome?.replace(/\/+$/, "");
  let cwd = state.cwd;
  if (home && state.cwd === home) cwd = "~";
  else if (home === "/" && state.cwd.startsWith("/")) cwd = `~${state.cwd}`;
  else if (home && state.cwd.startsWith(`${home}/`))
    cwd = `~${state.cwd.slice(home.length)}`;
  return (state.env.PS1 ?? "📁 \\w\n$ ").replaceAll("\\w", cwd);
}

async function interactive(state) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  const closed = new Promise((resolve) => readline.once("close", () => resolve(null)));
  try {
    while (!state.exitRequested) {
      const line = await Promise.race([
        readline.question(renderPrompt(state)),
        closed,
      ]);
      if (line === null) break;
      await execute(line, state);
    }
  } finally {
    readline.close();
  }
  return state.exitRequested ? state.exitStatus : state.lastStatus;
}

async function main(argv) {
  let command = null;
  let forceInteractive = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-c") {
      if (i + 1 >= argv.length) {
        console.error("bunmsh: -c requires an argument");
        return 2;
      }
      command = argv[++i];
      i++;
      break;
    }
    if (arg === "-i") {
      forceInteractive = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    }
    if (arg === "-V" || arg === "--version") {
      console.log(VERSION);
      return 0;
    }
    if (arg === "--readme") {
      await printReadme();
      return 0;
    }
    if (arg.startsWith("-")) {
      console.error(`bunmsh: ${arg}: unknown option`);
      return 2;
    }
    break;
  }

  if (command !== null) {
    const name = argv[i] ?? "bunmsh";
    const state = createState({ args: [name, ...argv.slice(i + 1)] });
    const result = await execute(command, state);
    return state.exitRequested ? state.exitStatus : result.status;
  }

  if (i < argv.length) {
    const script = argv[i];
    try {
      const source = await Bun.file(script).text();
      const state = createState({ args: [script, ...argv.slice(i + 1)] });
      const result = await execute(source, state);
      if (forceInteractive && !state.exitRequested) return interactive(state);
      return state.exitRequested ? state.exitStatus : result.status;
    } catch (error) {
      console.error(`bunmsh: ${script}: ${error.message}`);
      return 1;
    }
  }

  const state = createState();
  if (forceInteractive || process.stdin.isTTY) return interactive(state);
  const source = await Bun.stdin.text();
  const result = await execute(source, state);
  return state.exitRequested ? state.exitStatus : result.status;
}

await buildEarlyExit(process.argv, "bmsh");
process.exitCode = await main(process.argv.slice(2));
