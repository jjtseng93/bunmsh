// The fallback grep, after GNU grep 3.11 for the options it takes. Results stream:
// `write`, when given, takes the output as each file chunk (or, with --line-buffered,
// each line) is searched, so a long recursive search shows its first match at once;
// without it everything is gathered and returned, as a captured `$(grep ...)` needs.
//
// Recursion follows GNU: -r follows symbolic links only when they are operands, -R
// follows all of them and reports a directory loop instead of entering it, and in
// both only regular files and directories are read, so a FIFO never blocks the walk.
// A file that cannot be read is reported and the search goes on; the exit status is
// then 2, unless -q already found a match. Files are read in chunks, never whole.
//
// A file whose data holds a NUL is binary. By default its first selected line prints
// "binary file matches" to stderr instead of the line; -a (--text, --binary-files=text)
// searches it as text. -I skips streams with NUL in their first 32 KiB; later
// bytes are searched as text, keeping memory bounded and emitted matches consistent.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const STRERROR = {
  ENOENT: "No such file or directory", EACCES: "Permission denied", EPERM: "Operation not permitted",
  ELOOP: "Too many levels of symbolic links", ENOTDIR: "Not a directory", EISDIR: "Is a directory",
  EIO: "Input/output error", ENAMETOOLONG: "File name too long",
};
const reason = (error) => STRERROR[error?.code] ?? String(error?.message ?? error);

// Basic regular expressions: \+ \? \| \( \) \{ \} are operators, the bare characters are literal.
export function grepBasicRegex(pattern) {
  let output = "", inClass = false, branchStart = true;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (!inClass && ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[++i];
      output += "+?|(){}".includes(next) ? next : `\\${next}`;
      branchStart = next === "(" || next === "|";
      continue;
    }
    if (!inClass && ch === "$") {
      const anchored = i === pattern.length - 1 || pattern.startsWith("\\)", i + 1) || pattern.startsWith("\\|", i + 1);
      output += anchored ? "$" : "\\$";
    } else if (!inClass && ch === "^") output += branchStart ? "^" : "\\^";
    else if (!inClass && "+?|(){}".includes(ch)) output += `\\${ch}`;
    else output += ch;
    if (ch === "[") inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    branchStart = false;
  }
  return output;
}

export function grepPosixClasses(pattern) {
  const classes = {
    alnum: "A-Za-z0-9", alpha: "A-Za-z", blank: " \\t", digit: "0-9",
    lower: "a-z", space: "\\s", upper: "A-Z", word: "A-Za-z0-9_",
    xdigit: "A-Fa-f0-9",
  };
  return pattern.replace(/\[\[:(alnum|alpha|blank|digit|lower|space|upper|word|xdigit):\]\]/g,
    (_match, name) => `[${classes[name]}]`);
}

// GNU grep matches --exclude and --exclude-dir globs as fnmatch does without FNM_PATHNAME or
// FNM_PERIOD: * and ? also take "/" and a leading ".".
export function globRegex(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") source += "[^]*";
    else if (ch === "?") source += "[^]";
    else if (ch === "\\" && i + 1 < pattern.length) source += pattern[++i].replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) source += "\\[";
      else { const body = pattern.slice(i + 1, end); source += `[${body.startsWith("!") ? "^" + body.slice(1) : body}]`; i = end; }
    } else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}
// A walked entry is excluded by its own name; an operand by any of its "/"-separated suffixes.
const excludedName = (globs, name) => globs.some((glob) => glob.test(name));
function excludedOperand(globs, operand) {
  const trimmed = operand.replace(/\/+$/, "") || operand;
  if (excludedName(globs, trimmed)) return true;
  for (let at = trimmed.indexOf("/"); at >= 0; at = trimmed.indexOf("/", at + 1))
    if (excludedName(globs, trimmed.slice(at + 1))) return true;
  return false;
}

// Short options that are plain switches, and the long names that mean one of them.
const SWITCHES = "EFGiyvwxcqsnorRlLHhZIa";
const LONG_SWITCHES = {
  "extended-regexp": "E", "fixed-strings": "F", "basic-regexp": "G", "ignore-case": "i",
  "invert-match": "v", "word-regexp": "w", "line-regexp": "x", "count": "c", "quiet": "q",
  "silent": "q", "no-messages": "s", "line-number": "n", "only-matching": "o", "recursive": "r",
  "dereference-recursive": "R", "files-with-matches": "l", "files-without-match": "L",
  "with-filename": "H", "no-filename": "h", "null": "Z", "text": "a",
};

function parse(argv) {
  const options = { flags: new Set(), patterns: [], max: null, binary: "binary", color: "never", lineBuffered: false,
    exclude: [], excludeDir: [] };
  const flags = options.flags;
  // The last of -E, -F and -G wins, as do -H and -h, and -l and -L.
  const set = (flag) => {
    if ("EFG".includes(flag)) for (const other of "EFG") flags.delete(other);
    if ("Hh".includes(flag)) for (const other of "Hh") flags.delete(other);
    if ("lL".includes(flag)) for (const other of "lL") flags.delete(other);
    flags.add(flag === "y" ? "i" : flag);
  };
  const maxCount = (value) => {
    if (!/^\d+$/.test(String(value))) throw new Error(`invalid max count`);
    options.max = Number(value);
  };
  const binaryFiles = (value) => {
    if (!["binary", "text", "without-match"].includes(value)) throw new Error(`unknown binary-files type`);
    options.binary = value;
  };
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { i++; break; }
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split(/=(.*)/s, 2);
      const takes = (label) => {
        if (value !== undefined) return value;
        if (i + 1 >= argv.length) throw new Error(`option '--${name}' requires an argument`);
        return argv[++i];
      };
      if (name === "color" || name === "colour") {
        if (value !== undefined && !["always", "auto", "never"].includes(value)) throw new Error(`invalid argument '${value}' for '--color'`);
        options.color = value ?? "auto";
      } else if (name === "regexp") options.patterns.push(...takes().split("\n"));
      else if (name === "max-count") maxCount(takes());
      else if (name === "binary-files") binaryFiles(takes());
      else if (name === "line-buffered") options.lineBuffered = true;
      else if (name === "exclude") options.exclude.push(globRegex(takes()));
      else if (name === "exclude-dir") options.excludeDir.push(globRegex(takes()));
      else if (LONG_SWITCHES[name] && value === undefined) set(LONG_SWITCHES[name]);
      else throw new Error(`unsupported option: ${arg}`);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "e" || ch === "m") {
        const rest = arg.slice(j + 1);
        const value = rest.length ? rest : argv[++i];
        if (value === undefined) throw new Error(ch === "e" ? "-e requires a pattern" : "-m requires a count");
        if (ch === "e") options.patterns.push(...value.split("\n"));
        else maxCount(value);
        break;
      }
      if (!SWITCHES.includes(ch)) throw new Error(`unsupported option: -${ch}`);
      set(ch);
    }
  }
  if (!options.patterns.length) {
    if (i >= argv.length) throw new Error("missing pattern");
    options.patterns.push(...argv[i++].split("\n"));
  }
  if (flags.has("a")) options.binary = "text";
  if (flags.has("I")) options.binary = "without-match";
  options.operands = argv.slice(i);
  return options;
}

function compile(options) {
  const { flags, patterns } = options;
  const source = patterns.map(pattern => flags.has("F")
    ? pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    : grepPosixClasses(flags.has("E") ? pattern : grepBasicRegex(pattern))).map(p => `(?:${p})`).join("|");
  let wrapped = source;
  if (flags.has("x")) wrapped = `^(?:${source})$`;
  else if (flags.has("w")) wrapped = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  return new RegExp(wrapped, `${flags.has("i") ? "i" : ""}${flags.has("o") ? "g" : ""}`);
}

/**
 * Runs `grep` with `argv` (argv[0] is the command name). `cwd` resolves relative operands,
 * `input()` returns the ReadableStream for standard input, `tty` says whether stdout is a
 * terminal for --color=auto. Returns { status, stdout, stderr }; stdout is empty when `write`
 * took it.
 */
export async function runGrep(argv, { cwd = process.cwd(), platform = process.platform, input = null, write = null, tty = false } = {}) {
  let options, regex;
  try { options = parse(argv); regex = compile(options); }
  catch (error) { return { status: 2, stdout: "", stderr: `bunmsh: grep: ${error.message}\n` }; }
  const { flags, max, binary, lineBuffered } = options;
  const invert = flags.has("v"), quiet = flags.has("q"), numbers = flags.has("n"), only = flags.has("o");
  const listMatches = flags.has("l"), listMissing = flags.has("L");
  const counting = flags.has("c") && !listMatches && !listMissing;
  const recursive = flags.has("r") || flags.has("R"), follow = flags.has("R");
  const nul = flags.has("Z"), silent = flags.has("s");
  // Lines are printed only when no mode replaces them with a count, a name or nothing.
  const printsLines = !quiet && !counting && !listMatches && !listMissing;
  const color = options.color === "always" || (options.color === "auto" && tty);
  const red = "\x1b[01;31m", reset = "\x1b[m";
  const colored = (value) => color && value.length ? `${red}${value}${reset}` : value;
  const highlight = color && !only ? new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`) : null;
  const native = (value) => platform === "win32" ? value.replaceAll("/", "\\") : value;

  let stdout = "", stderr = "", pending = "", status = 1, failed = false, done = false;
  const flush = async () => {
    if (!pending) return;
    const text = pending;
    pending = "";
    if (write) await write(text); else stdout += text;
  };
  const out = async (text) => {
    pending += text;
    if (lineBuffered || pending.length >= 65536) await flush();
  };
  const fail = (message) => { failed = true; if (!silent) stderr += `bunmsh: grep: ${message}\n`; };
  const nameEnd = nul ? "\0" : "\n";
  const labelSep = nul ? "\0" : ":";

  // Searches one stream; `label` names it in output and messages.
  async function search(stream, label, showLabel) {
    if (max === 0) {
      if (!quiet && counting) await out(`${showLabel ? `${label}${labelSep}` : ""}0\n`);
      if (!quiet && listMissing) await out(`${label}${nameEnd}`);
      return;
    }
    const decoder = new TextDecoder();
    let rest = [], lineNo = 0, count = 0, isBinary = false, stop = false;
    const prefix = (n) => `${showLabel ? `${label}${labelSep}` : ""}${numbers ? `${n}:` : ""}`;
    const line = async (text) => {
      lineNo++;
      regex.lastIndex = 0;
      const isMatch = regex.test(text);
      regex.lastIndex = 0;
      if (isMatch === invert) return;
      count++;
      status = 0;
      if (quiet) { done = stop = true; return; }
      if (listMatches) { await out(`${label}${nameEnd}`); stop = true; return; }
      if (listMissing) { stop = true; return; }
      if (printsLines) {
        if (isBinary && binary === "binary") {
          await flush();
          stderr += `bunmsh: grep: ${label}: binary file matches\n`;
          stop = true;
          return;
        }
        if (only) {
          if (!invert) for (const match of text.matchAll(regex))
            if (match[0].length) await out(`${prefix(lineNo)}${colored(match[0])}\n`);
        } else {
          await out(`${prefix(lineNo)}${highlight ? text.replace(highlight, (match) => colored(match)) : text}\n`);
        }
      }
      if (max !== null && count >= max) stop = true;
    };
    const reader = stream.getReader();
    try {
      // A bounded initial probe is independent of pipe chunk boundaries. Do not
      // publish matches until these bytes have been classified; retain streaming
      // after the probe instead of buffering an entire possibly unbounded input.
      let initial = null, initialEnd = false;
      if (binary === "without-match") {
        const parts = [];
        let size = 0;
        while (size < 32768) {
          const next = await reader.read();
          if (next.done) { initialEnd = true; break; }
          parts.push(next.value); size += next.value.byteLength;
          if (next.value.subarray(0, Math.max(0, 32768 - (size - next.value.byteLength))).includes(0)) {
            isBinary = true; stop = true; break;
          }
        }
        initial = Buffer.concat(parts);
      }
      while (!stop) {
        const { value, done: end } = initial !== null
          ? { value: initial, done: false }
          : initialEnd ? { done: true } : await reader.read();
        initial = null;
        const text = end ? decoder.decode() : decoder.decode(value, { stream: true });
        if (binary !== "without-match" && !isBinary && text.includes("\0")) {
          isBinary = true;
        }
        // Only the new text is scanned for line ends, and an unfinished line is kept as parts, so a
        // file with very long lines (or none, as a binary may have) costs linear time.
        let from = 0, at;
        while (!stop && (at = text.indexOf("\n", from)) >= 0) {
          const piece = text.slice(from, at);
          const whole = rest.length ? rest.join("") + piece : piece;
          rest = [];
          from = at + 1;
          await line(whole);
        }
        if (!stop && from < text.length) rest.push(text.slice(from));
        if (end && !stop && rest.length) { const whole = rest.join(""); rest = []; await line(whole); }
        if (!lineBuffered) await flush();
        if (end) break;
      }
    } finally {
      if (stop) await reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
    if (done) return;
    if (counting) await out(`${showLabel ? `${label}${labelSep}` : ""}${isBinary && binary === "without-match" ? 0 : count}\n`);
    if (listMissing && count === 0) await out(`${label}${nameEnd}`);
    await flush();
  }

  async function searchFile(shown, path, showLabel) {
    let stream;
    try { stream = Bun.file(path).stream(); }
    catch (error) { fail(`${shown}: ${reason(error)}`); return; }
    try { await search(stream, shown, showLabel); }
    catch (error) { await flush(); fail(`${shown}: ${reason(error)}`); }
  }

  function readdirOrFail(shown, path) {
    try { return readdirSync(path, { withFileTypes: true }); }
    catch (error) { fail(`${shown}: ${reason(error)}`); return []; }
  }

  // Walks a directory in the order the system lists it, as GNU grep's fts walk does. Children
  // of the implicit "." (no operand) are named without "./", as GNU grep names them.
  async function walk(shown, path, entries, ancestors, showLabel) {
    for (const entry of entries) {
      if (done) return;
      const childShown = shown ? `${shown.replace(/\/$/, "")}/${entry.name}` : entry.name;
      const childPath = resolve(path, entry.name);
      let stats;
      try {
        if (entry.isSymbolicLink()) {
          if (!follow) continue;
          stats = statSync(childPath);
        } else if (entry.isDirectory()) stats = lstatSync(childPath);
        else if (entry.isFile()) {
          if (!excludedName(options.exclude, entry.name)) await searchFile(childShown, childPath, showLabel);
          continue;
        }
        else continue;
      } catch (error) { fail(`${childShown}: ${reason(error)}`); continue; }
      if (stats.isDirectory()) {
        if (excludedName(options.excludeDir, entry.name)) continue;
        const key = `${stats.dev}:${stats.ino}`;
        if (ancestors.has(key)) {
          if (!silent) stderr += `bunmsh: grep: ${childShown}: warning: recursive directory loop\n`;
          continue;
        }
        ancestors.add(key);
        await walk(childShown, childPath, readdirOrFail(childShown, childPath), ancestors, showLabel);
        ancestors.delete(key);
      } else if (stats.isFile() && !excludedName(options.exclude, entry.name)) await searchFile(childShown, childPath, showLabel);
    }
  }

  const operands = options.operands.slice();
  const implicitCwd = !operands.length && recursive;
  if (implicitCwd) operands.push(".");
  if (!operands.length) operands.push("-");
  const forced = flags.has("H") ? true : flags.has("h") ? false : null;
  const many = operands.length > 1;
  for (const operand of operands) {
    if (done) break;
    if (operand === "-") {
      await search(input?.() ?? Bun.stdin.stream(), "(standard input)", forced ?? many);
      continue;
    }
    const path = isAbsolute(native(operand)) ? native(operand) : resolve(cwd, native(operand));
    let stats;
    try { stats = statSync(path); }
    catch (error) { fail(`${operand}: ${reason(error)}`); continue; }
    if (stats.isDirectory()) {
      if (!recursive) { fail(`${operand}: Is a directory`); continue; }
      // The implicit "." of a bare -r is never excluded; a named one is, as GNU grep does.
      if (!implicitCwd && excludedOperand(options.excludeDir, operand)) continue;
      const ancestors = new Set([`${stats.dev}:${stats.ino}`]);
      // A directory operand names the files found in it, unless -h says otherwise.
      await walk(implicitCwd ? "" : operand, path, readdirOrFail(operand, path), ancestors, forced ?? true);
      continue;
    }
    if (excludedOperand(options.exclude, operand)) continue;
    await searchFile(operand, path, forced ?? many);
  }
  await flush();

  if (failed && !(quiet && status === 0)) status = 2;
  return { status, stdout, stderr };
}
