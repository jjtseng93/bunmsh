import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function importEnabled(env) {
  return !/^(?:0|false|off|no)$/i.test(env.BUNMSH_IMPORT_HISTORY ?? "");
}

// History is rendered directly beside the prompt. Reject the entire entry
// instead of stripping bytes and accidentally turning it into another command.
export function safeHistoryEntry(entry) {
  return typeof entry === "string" && entry.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(entry);
}

export function bunmshHistoryPath(env = process.env, platform = process.platform) {
  const trim = (value) => value?.replace(/[\\/]+$/, "");
  if (platform === "win32") {
    const base = trim(env.LOCALAPPDATA || env.APPDATA ||
      (env.USERPROFILE ? `${trim(env.USERPROFILE)}/AppData/Local` : ""));
    return base ? `${base}/bunmsh/history` : null;
  }
  const base = trim(env.XDG_DATA_HOME || (env.HOME ? `${trim(env.HOME)}/.local/share` : ""));
  return base ? `${base}/bunmsh/history` : null;
}

async function readableText(path) {
  const file = Bun.file(path);
  return await file.exists() ? file.text() : null;
}

export function parseBashHistory(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^#[0-9]+$/.test(line) && safeHistoryEntry(line));
}

export function parseFishHistory(source) {
  const records = source.split(/\r?\n/)
    .map((line) => /^- cmd:\s?(.*)$/.exec(line)?.[1] ?? null)
    .filter((entry) => entry !== null);
  // Fish documents this as "YAML-style", not YAML. Command scalars use Fish's
  // own escaping and can be rejected or only partially consumed by YAML
  // parsers. The stable record boundary is the unindented `- cmd:` prefix.
  return records
    .map((entry) => entry.replace(/\\(\\|n)/g, (_match, escaped) => escaped === "n" ? "\n" : "\\"))
    .filter(safeHistoryEntry);
}

function parseBunmshHistory(source) {
  const parsed = JSON.parse(source);
  return Array.isArray(parsed) ? parsed.filter(safeHistoryEntry) : [];
}

export async function saveBunmshHistory(history, env = process.env, platform = process.platform) {
  const path = bunmshHistoryPath(env, platform);
  if (!path) throw new Error("cannot determine bunmsh history path");
  mkdirSync(dirname(path), { recursive: true });
  const seen = new Set();
  const unique = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (!safeHistoryEntry(entry) || seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }
  await Bun.write(path, `${JSON.stringify(unique.reverse(), null, 2)}\n`);
  return path;
}

export async function importedHistory(env = process.env, platform = process.platform) {
  const home = env.HOME?.replace(/\/+$/, "");
  const paths = [];
  if (importEnabled(env) && home) paths.push(
    { type: "bash", path: env.HISTFILE || `${home}/.bash_history` },
    { type: "fish", path: `${home}/.local/share/fish/fish_history` },
  );
  const ownPath = bunmshHistoryPath(env, platform);
  if (ownPath) paths.push({ type: "bunmsh", path: ownPath });
  const history = [];
  for (const item of paths) {
    try {
      const source = await readableText(item.path);
      if (source === null) continue;
      history.push(...(item.type === "fish" ? parseFishHistory(source) :
        item.type === "bunmsh" ? parseBunmshHistory(source) : parseBashHistory(source)));
    } catch {}
  }
  // Keep the most recent occurrence, matching historyGhost's reverse lookup.
  const seen = new Set();
  const unique = [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (seen.has(history[index])) continue;
    seen.add(history[index]);
    unique.push(history[index]);
  }
  return unique.reverse();
}
