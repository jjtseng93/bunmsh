import { lstatSync, readdirSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]);
const MUSIC = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus", "mid", "midi"]);
const VIDEO = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v", "mpeg", "mpg"]);
const ICONS = new Map([
  ["js", "🟨"], ["mjs", "🟨"], ["cjs", "🟨"],
  ["ts", "🟦"], ["mts", "🟦"], ["cts", "🟦"],
  ["py", "🐍"], ["c", "🔧"], ["h", "🧩"], ["rs", "🦀"],
  ["html", "🌐"], ["htm", "🌐"], ["css", "🎨"],
]);

function extension(name) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

function iconFor(name, stats) {
  if (stats.isDirectory()) return "📦";
  if (stats.isSymbolicLink()) return "🔗";
  const ext = extension(name);
  if (IMAGE.has(ext)) return "🖼️";
  if (MUSIC.has(ext)) return "🎵";
  if (VIDEO.has(ext)) return "🎬";
  if (ICONS.has(ext)) return ICONS.get(ext);
  if (stats.mode & 0o111) return "⚙️";
  return "📄";
}

function displayEntry(entry) {
  return `${iconFor(entry.name, entry.stats)} ${entry.name}${entry.stats.isDirectory() ? "/" : ""}`;
}

function columns(items, width) {
  if (!items.length) return "";
  const widest = Math.max(...items.map((item) => Bun.stringWidth(item))) + 2;
  const count = Math.max(1, Math.floor(width / widest));
  let output = "";
  for (let index = 0; index < items.length; index++) {
    const last = index % count === count - 1 || index === items.length - 1;
    output += items[index];
    output += last ? "\n" : " ".repeat(widest - Bun.stringWidth(items[index]));
  }
  return output;
}

function modeString(mode) {
  const kinds = [[0o400, "r"], [0o200, "w"], [0o100, "x"], [0o040, "r"], [0o020, "w"], [0o010, "x"], [0o004, "r"], [0o002, "w"], [0o001, "x"]];
  return kinds.map(([bit, letter]) => mode & bit ? letter : "-").join("");
}

function humanSize(bytes) {
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M", "G", "T", "P"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
}

function listDirectory(path, options) {
  let entries = readdirSync(path, { withFileTypes: true })
    .filter((entry) => options.all || options.almostAll || !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, stats: lstatSync(resolve(path, entry.name)) }));
  if (options.all) entries = [
    { name: ".", stats: lstatSync(path) },
    { name: "..", stats: lstatSync(resolve(path, "..")) },
    ...entries,
  ];
  entries.sort(options.time
    ? (a, b) => b.stats.mtimeMs - a.stats.mtimeMs || a.name.localeCompare(b.name)
    : (a, b) => a.name.localeCompare(b.name));
  if (options.reverse) entries.reverse();
  return entries;
}

export function fancyLs(argv, state, terminal = Boolean(process.stdout.isTTY)) {
  const options = {
    all: false, almostAll: false, directory: false, long: false, human: false,
    recursive: false, time: false, reverse: false,
  };
  const operands = [];
  for (const argument of argv.slice(1)) {
    if (argument === "--color=auto" || argument === "--color" || argument === "--") continue;
    if (/^-[^-]/.test(argument)) {
      for (const flag of argument.slice(1)) {
        if (flag === "a") options.all = true;
        else if (flag === "A") options.almostAll = true;
        else if (flag === "d") options.directory = true;
        else if (flag === "l") options.long = true;
        else if (flag === "h") options.human = true;
        else if (flag === "R") options.recursive = true;
        else if (flag === "t") options.time = true;
        else if (flag === "r") options.reverse = true;
        else return { status: 2, stdout: "", stderr: `bunmsh: lsfancy: unsupported option: -${flag}\n` };
      }
    } else operands.push(argument);
  }
  if (!operands.length) operands.push(".");
  let status = 0, stdout = "", stderr = "";
  const visited = new Set();
  const show = (operand, heading = operands.length > 1) => {
    const path = isAbsolute(operand) ? operand : resolve(state.cwd, operand);
    try {
      const stats = lstatSync(path);
      let entries;
      if (!stats.isDirectory() || options.directory)
        entries = [{ name: basename(operand) || operand, stats }];
      else entries = listDirectory(path, options);
      if (heading) stdout += `${operand}:\n`;
      const rendered = entries.map(displayEntry);
      if (options.long) {
        for (let i = 0; i < entries.length; i++) {
          const item = entries[i];
          const date = new Date(item.stats.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
          const size = options.human ? humanSize(item.stats.size) : String(item.stats.size);
          stdout += `${item.stats.isDirectory() ? "d" : item.stats.isSymbolicLink() ? "l" : "-"}${modeString(item.stats.mode)} ${size.padStart(8)} ${date} ${rendered[i]}\n`;
        }
      } else stdout += terminal ? columns(rendered, process.stdout.columns ?? 80) : `${rendered.join("\n")}${rendered.length ? "\n" : ""}`;
      if (options.recursive && stats.isDirectory() && !options.directory) {
        for (const entry of entries) if (entry.stats.isDirectory() && entry.name !== "." && entry.name !== "..") {
          const child = resolve(path, entry.name);
          if (visited.has(child)) continue;
          visited.add(child);
          stdout += "\n";
          show(`${operand.replace(/\/$/, "")}/${entry.name}`, true);
        }
      }
    } catch (error) {
      status = 1;
      stderr += `bunmsh: lsfancy: ${operand}: ${error.message}\n`;
    }
  };
  for (let i = 0; i < operands.length; i++) {
    if (i) stdout += "\n";
    show(operands[i]);
  }
  return { status, stdout, stderr };
}
