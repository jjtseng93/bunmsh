#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import {
  builtinNames,
  createState,
  execute,
  executeArgv,
  executeBunShellFallback,
  pipelineChildState,
} from "./shell.js";
import {
  CommandIndex,
  FileIndex,
  completionContext,
  fitGhost,
  historyGhost,
  nextGhostChunk,
} from "./completion.js";
import { readAssetText } from "../single-exe/assetsHelper.js";
import { buildEarlyExit } from "../single-exe/compiled.js";
import { importedHistory, readlineHistory } from "./history.js";
import pkg from "../package.json" with { type:"json" }
import { MOUSE_OFF, MOUSE_ON, mouseInput } from "./mouse.js";
import { homeRelativePath } from "./environment.js";

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

async function printChangelog() {
  const source = await readAssetText("CHANGELOG.md");
  console.log(
    Bun.markdown?.ansi(source, { hyperlinks: true }) || source,
  );
}

function usage() {
  console.log(`
Usage:
  bunmsh [options]
  bunmsh <script_path> [argv Array]
  bunmsh -c <script_text> [argv Array]
  bunmsh -cc <command> [argv Array]

Options:
  -c <script_text> [argv Array]
    Command text as shell script 
      → Parse & Execute
      
    -c 'echo "$0" "$1"' Hello world
      → Hello world
      
  -cc <command> [argv Array]
    Call Command with argv as is
      Can be alias/builtin or from PATH
      Without shell parsing
      Without shell expansions
      
    -cc echo '$HOME' '*.js'
      → $HOME *.js
    -cc lsfancy -lh
      → List cwd with emojis

  --mouse      Enable mouse events
  --builtin-only
               Skip $PATH lookup
               
  -i           Enter interactive mode
  
  -V, --version
               Show version
  -h, --help   Show this help
  --readme     Show bunmsh's README.md
  --changelog  Show bunmsh's CHANGELOG.md
  
  --build-exe
      Build ./bmsh for the current platform
  --build-for TARGET
      Cross-compile ./bmsh for TARGET
`);
}

function renderCwd(state, cwd) {
  const relative = homeRelativePath(cwd, state.env.HOME);
  return relative === null ? cwd : `~${relative}`;
}

function renderPrompt(state, withRegions = false) {
  const tabParts = state.tabs.length > 1
    ? state.tabs.map((path, index) =>
        index === state.activeTab
          ? `\x1b[38;5;81m📂 ${renderCwd(state, path)}\x1b[0m`
          : `📁 ${renderCwd(state, path)}`)
    : null;
  const cwd = tabParts ? tabParts.join("  ") : renderCwd(state, state.cwd);
  const defaultPrompt = state.tabs.length > 1
    ? `\\w\n[${state.activeTab + 1}]$ `
    : "📁 \\w\n$ ";
  const template = state.env.PS1 ?? defaultPrompt;
  const styledTemplate = state.lastStatus === 0
    ? template
    : template.replaceAll("$", "\x1b[31m$\x1b[0m");
  const text = styledTemplate.replaceAll("\\w", cwd);
  if (!withRegions || !tabParts) return { text, regions: [], newTabRegion: [] };
  const prefix = styledTemplate.slice(0, styledTemplate.indexOf("\\w"));
  const columns = process.stdout.columns ?? 80;
  let row = 0, column = 0;
  const advance = (source, cells = null) => {
    for (let i = 0; i < source.length;) {
      const ansi = /^\x1b\[[0-9;]*m/.exec(source.slice(i));
      if (ansi) { i += ansi[0].length; continue; }
      const character = String.fromCodePoint(source.codePointAt(i));
      i += character.length;
      if (character === "\n") { row++; column = 0; continue; }
      const width = Bun.stringWidth(character);
      for (let n = 0; n < width; n++) {
        if (column >= columns) { row++; column = 0; }
        cells?.push({ row, column });
        column++;
      }
    }
  };
  advance(prefix);
  const regions = tabParts.map((part, index) => {
    const cells = [];
    advance(part, cells);
    if (index + 1 < tabParts.length) advance("  ");
    return cells;
  });
  const newTabRegion = [];
  const marker = `[${state.activeTab + 1}]$`;
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    row = 0;
    column = 0;
    advance(text.slice(0, markerIndex + 1));
    advance(String(state.activeTab + 1), newTabRegion);
  }
  return { text, regions, newTabRegion };
}

async function interactive(state) {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let mouseTracking = terminal && state.mouseTracking;
  const commandIndex = new CommandIndex(builtinNames());
  const fileIndex = new FileIndex();
  state.history = await importedHistory(state.env);
  const history = state.history;
  if (terminal) await commandIndex.refresh(state);
  let readline;
  let promptRegions = [];
  let newTabRegion = [];
  let pendingClick = null;
  let pendingCursorQuery = null;
  let lastTabClick = null;
  let mouseCommandRunning = false;
  let foregroundCommand = false;
  let promptAbort = null;
  const runTabShortcut = (args) => {
    if (!readline || mouseCommandRunning) return;
    mouseCommandRunning = true;
    void executeArgv(["builtin", "tab", ...args], state, { capture: true }).finally(() => {
      mouseCommandRunning = false;
      const next = renderPrompt(state, true);
      promptRegions = next.regions;
      newTabRegion = next.newTabRegion;
      readline.setPrompt(next.text);
      readline.prompt(true);
    });
  };
  const runFancyShortcut = (args = []) => {
    if (!readline || mouseCommandRunning) return;
    mouseCommandRunning = true;
    // readline.prompt(true) moves upward by the current prompt/edit buffer's
    // row count before repainting. Reserve those rows below the listing so it
    // clears the reserved space instead of overwriting a short lsfancy result.
    const repaintRows = readline.getCursorPos().rows;
    process.stdout.write("\r\x1b[0J\n");
    void executeArgv(["builtin", "lsfancy", ...args], state).finally(() => {
      mouseCommandRunning = false;
      if (repaintRows > 0) process.stdout.write("\n".repeat(repaintRows));
      const next = renderPrompt(state, true);
      promptRegions = next.regions;
      newTabRegion = next.newTabRegion;
      readline.setPrompt(next.text);
      readline.prompt(true);
    });
  };
  const queryCursor = () => new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingCursorQuery?.resolve === resolve) pendingCursorQuery = null;
      resolve(null);
    }, 60);
    pendingCursorQuery = {
      resolve(position) {
        clearTimeout(timer);
        pendingCursorQuery = null;
        resolve(position);
      },
    };
    process.stdout.write("\x1b[6n");
  });
  const filteredInput = terminal ? mouseInput((mouse) => {
    if (!mouse.press || (mouse.button & 3) !== 0 || (mouse.button & 32)) return;
    pendingClick = { ...mouse, at: Date.now() };
    process.stdout.write("\x1b[6n");
  }, (position) => {
    if (pendingCursorQuery) {
      pendingCursorQuery.resolve(position);
      return;
    }
    const { row } = position;
    if (!pendingClick || !readline) return;
    const click = pendingClick;
    pendingClick = null;
    const cursor = readline.getCursorPos();
    const relativeRow = click.y - (row - cursor.rows);
    const relativeColumn = click.x - 1;
    if (newTabRegion.some((cell) =>
      cell.row === relativeRow && cell.column === relativeColumn)) {
      lastTabClick = null;
      runTabShortcut(["n"]);
      return;
    }
    const index = promptRegions.findIndex((cells) =>
      cells.some((cell) => cell.row === relativeRow && cell.column === relativeColumn));
    if (index < 0) return;
    const doubleClick = lastTabClick?.index === index &&
      click.at - lastTabClick.at <= 400;
    lastTabClick = doubleClick ? null : { index, at: click.at };
    if (index !== state.activeTab) {
      state.activeTab = index;
      state.cwd = state.tabs[index];
      state.env.PWD = state.cwd;
    }
    const rendered = renderPrompt(state, true);
    promptRegions = rendered.regions;
    newTabRegion = rendered.newTabRegion;
    readline.setPrompt(rendered.text);
    if (!doubleClick || mouseCommandRunning) {
      readline.prompt(true);
      return;
    }
    runFancyShortcut();
  }, (shortcut) => {
    if (shortcut === "tab") runTabShortcut([]);
    else if (shortcut === "tab-left") runTabShortcut(["l"]);
    else if (shortcut === "lsfancy") runFancyShortcut();
    else if (shortcut === "lsfancy-parent") runFancyShortcut([".."]); 
    else if (shortcut === "tab-close") runTabShortcut(["x"]);
  }) : process.stdin;
  const completer = (line) => {
    commandIndex.refreshIfChanged(state);
    const context = completionContext(line);
    if (context.command) {
      return [
        context.prefix.includes("/")
          ? fileIndex.matches(context.prefix, state)
          : commandIndex.matches(context.prefix),
        context.prefix,
      ];
    }
    if (!context.prefix)
      return [fileIndex.matches("", state), ""];
    const fromHistory = historyGhost(history, line);
    const fileMatch = fileIndex.first(context.prefix, state);
    const ghost = fromHistory ?? (fileMatch ? fileMatch.slice(context.prefix.length) : null);
    const chunk = nextGhostChunk(ghost);
    return chunk ? [[`${line}${chunk}`], line] : [[], line];
  };
  const resizeListenersBeforeReadline = terminal
    ? new Set(process.stdout.listeners("resize"))
    : null;
  readline = createInterface({
    input: filteredInput,
    output: process.stdout,
    terminal,
    completer,
    history: readlineHistory(history),
    historySize: Math.max(1000, history.length + 1000),
  });
  // readline refreshes its prompt whenever stdout emits "resize", even while
  // the interface is paused. Termux emits a resize when its app returns to the
  // foreground, which otherwise paints the shell's cwd prompt over a running
  // server or other foreground command.
  const readlineResizeListeners = terminal
    ? process.stdout.listeners("resize").filter(
        (listener) => !resizeListenersBeforeReadline.has(listener))
    : [];
  const setReadlineResizeEnabled = (enabled) => {
    for (const listener of readlineResizeListeners) {
      if (enabled) {
        if (!process.stdout.listeners("resize").includes(listener))
          process.stdout.on("resize", listener);
      } else {
        process.stdout.off("resize", listener);
      }
    }
  };
  const interrupt = () => {
    state.lastStatus = 130;
    if (foregroundCommand || promptAbort?.signal.aborted) return;
    process.stdout.write("\n");
    promptAbort?.abort();
  };
  readline.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  let refreshTimer = null;
  let removeGhostHooks = () => {};
  if (terminal) {
    process.stdin.pipe(filteredInput);
    if (mouseTracking) process.stdout.write(MOUSE_ON);
    refreshTimer = setInterval(() => void commandIndex.refresh(state), 10_000);
    refreshTimer.unref?.();

    let ghostWidth = 0;
    let startedAtEnd = false;
    let renderTask = null;
    const currentGhost = () => {
      if (readline.cursor !== readline.line.length) return null;
      const context = completionContext(readline.line, readline.cursor);
      if (context.command) {
        const match = context.prefix.includes("/")
          ? fileIndex.first(context.prefix, state)
          : commandIndex.first(context.prefix);
        return match ? match.slice(context.prefix.length) : null;
      }
      const fromHistory = historyGhost(history, readline.line);
      if (fromHistory) return fromHistory;
      const match = fileIndex.first(context.prefix, state);
      return match ? match.slice(context.prefix.length) : null;
    };
    const clearGhost = () => {
      if (!ghostWidth) return;
      process.stdout.write("\x1b[0K");
      ghostWidth = 0;
    };
    const visibleGhost = (ghost) => {
      const columns = process.stdout.columns ?? 80;
      const cursor = readline.getCursorPos?.();
      const available = Math.max(0, columns - (cursor?.cols ?? 0) - 1);
      return fitGhost(ghost, available);
    };
    const renderGhost = () => {
      renderTask = null;
      clearGhost();
      const ghost = currentGhost();
      if (!ghost) return;
      const visible = visibleGhost(ghost);
      ghostWidth = visible.width;
      if (!ghostWidth) return;
      process.stdout.write(`\x1b[2m${visible.output}\x1b[0m`);
      if (ghostWidth) process.stdout.write(`\x1b[${ghostWidth}D`);
    };
    const beforeKey = () => {
      startedAtEnd = readline.cursor === readline.line.length;
      clearGhost();
    };
    const afterKey = (_text, key = {}) => {
      if (key.name === "right" && startedAtEnd) {
        const ghost = currentGhost();
        if (ghost) readline.write(ghost);
      }
      if (renderTask !== null) clearTimeout(renderTask);
      renderTask = setTimeout(renderGhost, 0);
    };
    filteredInput.prependListener("keypress", beforeKey);
    filteredInput.on("keypress", afterKey);
    removeGhostHooks = () => {
      if (renderTask !== null) clearTimeout(renderTask);
      clearGhost();
      filteredInput.off("keypress", beforeKey);
      filteredInput.off("keypress", afterKey);
    };
  }
  const closed = new Promise((resolve) => readline.once("close", () => resolve(null)));
  try {
    while (!state.exitRequested) {
      const rendered = renderPrompt(state, true);
      promptRegions = rendered.regions;
      newTabRegion = rendered.newTabRegion;
      readline.setPrompt(rendered.text);
      promptAbort = new AbortController();
      let line;
      try {
        line = await Promise.race([
          readline.question(rendered.text, { signal: promptAbort.signal }),
          closed,
        ]);
      } catch (error) {
        if (error?.name === "AbortError") continue;
        throw error;
      } finally {
        promptAbort = null;
      }
      if (line === null) break;
      if (line && history.at(-1) !== line) history.push(line);
      // readline must not keep reading from the terminal while a foreground
      // program owns it.  Otherwise both processes race for input and the
      // first key (notably Ctrl-Q in full-screen editors) can be consumed by
      // the shell.  Also give the child a sane terminal mode to start from.
      readline.pause();
      setReadlineResizeEnabled(false);
      if (terminal) {
        if (mouseTracking) process.stdout.write(MOUSE_OFF);
        process.stdin.unpipe(filteredInput);
      }
      if (terminal) process.stdin.setRawMode(false);
      foregroundCommand = true;
      try {
        await execute(line, state);
      } finally {
        foregroundCommand = false;
        if (!state.exitRequested) {
          if (terminal) process.stdin.setRawMode(true);
          if (terminal) {
            process.stdin.pipe(filteredInput);
            // External commands stream directly to the terminal, so their
            // final byte cannot be inferred from an execution result. Ask the
            // terminal where the cursor is and terminate an unfinished line
            // before readline paints a multi-line prompt over it.
            const cursor = await queryCursor();
            if (cursor && cursor.column > 1) process.stdout.write("↩️\n");
            mouseTracking = Boolean(state.mouseTracking);
            if (mouseTracking) process.stdout.write(MOUSE_ON);
          }
          setReadlineResizeEnabled(true);
          readline.resume();
        }
      }
    }
  } finally {
    if (terminal) {
      if (mouseTracking) process.stdout.write(MOUSE_OFF);
      process.stdin.unpipe(filteredInput);
    }
    if (refreshTimer !== null) clearInterval(refreshTimer);
    removeGhostHooks();
    readline.off("SIGINT", interrupt);
    process.off("SIGINT", interrupt);
    readline.close();
  }
  return state.exitRequested ? state.exitStatus : state.lastStatus;
}

async function main(argv) {
  if (argv[0] === "--bun-shell-fallback")
    return executeBunShellFallback(argv.slice(1));
  let command = null;
  let forwardedArgv = null;
  let forceInteractive = false;
  let forceMouse = false;
  let builtinOnly = false;
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
    if (arg === "--mouse") {
      forceMouse = true;
      continue;
    }
    if (arg === "--builtin-only") {
      builtinOnly = true;
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
    if (arg === "--changelog") {
      await printChangelog();
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
    if (forceMouse) state.mouseTracking = true;
    if (builtinOnly) state.pathSearch = false;
    const result = await executeArgv(forwardedArgv, state);
    return state.exitRequested ? state.exitStatus : result.status;
  }

  if (command !== null) {
    const name = argv[i] ?? "bunmsh";
    const state = createState({
      args: [name, ...argv.slice(i + 1)],
      mouseTracking: forceMouse || undefined,
      pathSearch: builtinOnly ? false : undefined,
    });
    const result = await execute(command, state);
    return state.exitRequested ? state.exitStatus : result.status;
  }

  if (i < argv.length) {
    const script = argv[i];
    try {
      const source = await Bun.file(script).text();
      const state = createState({
        args: [script, ...argv.slice(i + 1)],
        mouseTracking: forceMouse || undefined,
        pathSearch: builtinOnly ? false : undefined,
      });
      const result = await execute(source, state);
      if (forceInteractive && !state.exitRequested) return interactive(state);
      return state.exitRequested ? state.exitStatus : result.status;
    } catch (error) {
      console.error(`bunmsh: ${script}: ${error.message}`);
      return 1;
    }
  }

  const state = createState({
    mouseTracking: forceMouse || undefined,
    pathSearch: builtinOnly ? false : undefined,
  });
  if (forceInteractive || process.stdin.isTTY) return interactive(state);
  const source = await Bun.stdin.text();
  const result = await execute(source, state);
  return state.exitRequested ? state.exitStatus : result.status;
}

await buildEarlyExit(process.argv, "bmsh");
process.exitCode = await main(process.argv.slice(2));
