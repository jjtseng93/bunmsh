#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { createState, execute, executeArgv, pipelineChildState } from "./shell.js";
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
  bunmsh -cc command [arguments...]

Options:
  -c command   Execute command text
  -cc command  Forward already-quoted argv without shell expansion
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

function renderCwd(state, cwd) {
  const rawHome = state.env.HOME;
  const home = rawHome === "/" ? "/" : rawHome?.replace(/\/+$/, "");
  if (home && cwd === home) return "~";
  if (home === "/" && cwd.startsWith("/")) return `~${cwd}`;
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function renderPrompt(state) {
  const cwd = state.tabs.length > 1
    ? state.tabs.map((path, index) =>
        `${index === state.activeTab ? "📂" : "📁"} ${renderCwd(state, path)}`,
      ).join("  ")
    : renderCwd(state, state.cwd);
  const defaultPrompt = state.tabs.length > 1
    ? `\\w\n[${state.activeTab + 1}]$ `
    : "📁 \\w\n$ ";
  return (state.env.PS1 ?? defaultPrompt).replaceAll("\\w", cwd);
}

async function interactive(state) {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
  });
  const closed = new Promise((resolve) => readline.once("close", () => resolve(null)));
  try {
    while (!state.exitRequested) {
      const line = await Promise.race([
        readline.question(renderPrompt(state)),
        closed,
      ]);
      if (line === null) break;
      // readline must not keep reading from the terminal while a foreground
      // program owns it.  Otherwise both processes race for input and the
      // first key (notably Ctrl-Q in full-screen editors) can be consumed by
      // the shell.  Also give the child a sane terminal mode to start from.
      readline.pause();
      if (terminal) process.stdin.setRawMode(false);
      try {
        await execute(line, state);
      } finally {
        if (!state.exitRequested) {
          if (terminal) process.stdin.setRawMode(true);
          readline.resume();
        }
      }
    }
  } finally {
    readline.close();
  }
  return state.exitRequested ? state.exitStatus : state.lastStatus;
}

async function main(argv) {
  let command = null;
  let forwardedArgv = null;
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
    if (arg === "-cc") {
      forwardedArgv = argv.slice(i + 1);
      i = argv.length;
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

  if (forwardedArgv !== null) {
    if (forwardedArgv.length === 0) {
      console.error("bunmsh: -cc requires a command");
      return 2;
    }
    const state = pipelineChildState();
    const result = await executeArgv(forwardedArgv, state);
    return state.exitRequested ? state.exitStatus : result.status;
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
