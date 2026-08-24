import { constants as fsConstants, accessSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename as pathBasename, dirname as pathDirname, isAbsolute, resolve as resolvePath } from "node:path";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_ALIASES = {
  ls: ["ls", "--color=auto"],
  diff: ["diff", "--color=auto"],
  grep: ["grep", "--color=auto"],
};
const DEFAULT_COMMAND_PATH = "/bin:/usr/bin";

export class ShellSyntaxError extends Error {
  constructor(message, offset = -1) {
    super(message);
    this.name = "ShellSyntaxError";
    this.offset = offset;
  }
}

function isNameStart(ch) {
  return /[A-Za-z_]/.test(ch ?? "");
}

function isNameChar(ch) {
  return /[A-Za-z0-9_]/.test(ch ?? "");
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\r";
}

function wordToken(offset) {
  return { type: "word", fragments: [], offset };
}

function pushFragment(word, text, quote) {
  if (text === "") {
    if (quote !== "none") word.fragments.push({ text, quote });
    return;
  }
  const previous = word.fragments.at(-1);
  if (previous?.quote === quote) previous.text += text;
  else word.fragments.push({ text, quote });
}

function substitutionEnd(source, start) {
  if (source[start] === "`") {
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === "`") return i + 1;
    }
    throw new ShellSyntaxError("unterminated command substitution", start);
  }
  if (source[start] !== "$" || source[start + 1] !== "(") return start;
  let depth = source[start + 2] === "(" ? 2 : 1;
  let quote = null;
  for (let i = start + 2 + (depth === 2 ? 1 : 0); i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  throw new ShellSyntaxError("unterminated substitution", start);
}

function parameterEnd(source, start) {
  let depth = 1;
  for (let i = start + 2; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "$" && source[i + 1] === "{") { depth++; i++; continue; }
    if (source[i] === "}" && --depth === 0) return i + 1;
  }
  throw new ShellSyntaxError("unterminated parameter expansion", start);
}

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let current = null;
  let atWordBoundary = true;

  const finishWord = () => {
    if (current) tokens.push(current);
    current = null;
  };
  const ensureWord = () => {
    current ??= wordToken(i);
    atWordBoundary = false;
    return current;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\n") {
      finishWord();
      tokens.push({ type: "op", value: ";", offset: i++ });
      atWordBoundary = true;
      continue;
    }
    if (isSpace(ch)) {
      finishWord();
      i++;
      atWordBoundary = true;
      continue;
    }
    if (ch === "#" && atWordBoundary && !current) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    const two = source.slice(i, i + 2);
    const operatorAhead =
      ["|", ";", "<", ">"].includes(ch) ||
      two === "&&" ||
      two === "||" ||
      two === "2>";
    if (current && operatorAhead) {
      finishWord();
      continue;
    }
    if (!current && ["&&", "||", ">>", "2>", "2>>"].includes(
      source.slice(i, i + 3) === "2>>" ? source.slice(i, i + 3) : two,
    )) {
      const value = source.slice(i, i + 3) === "2>>" ? "2>>" : two;
      tokens.push({ type: "op", value, offset: i });
      i += value.length;
      atWordBoundary = true;
      continue;
    }
    if (!current && ["|", ";", "<", ">"].includes(ch)) {
      tokens.push({ type: "op", value: ch, offset: i++ });
      atWordBoundary = true;
      continue;
    }

    if (ch === "'") {
      const word = ensureWord();
      const start = ++i;
      while (i < source.length && source[i] !== "'") i++;
      if (i >= source.length)
        throw new ShellSyntaxError("unterminated single quote", start - 1);
      pushFragment(word, source.slice(start, i), "single");
      i++;
      continue;
    }

    if (ch === '"') {
      const word = ensureWord();
      i++;
      let text = "";
      let closed = false;
      while (i < source.length) {
        if (source[i] === '"') {
          closed = true;
          i++;
          break;
        }
        if (source[i] === "\\" && i + 1 < source.length) {
          const next = source[i + 1];
          if (next === "$" || next === '"' || next === "\\" || next === "\n") {
            text += next === "\n" ? "" : `\u0000${next}`;
            i += 2;
            continue;
          }
        }
        if ((source[i] === "$" && ["(", "{"].includes(source[i + 1])) || source[i] === "`") {
          const end = source[i + 1] === "{" ? parameterEnd(source, i) : substitutionEnd(source, i);
          text += source.slice(i, end);
          i = end;
          continue;
        }
        text += source[i++];
      }
      if (!closed)
        throw new ShellSyntaxError("unterminated double quote", i);
      pushFragment(word, text, "double");
      continue;
    }

    if (ch === "\\") {
      const word = ensureWord();
      if (i + 1 >= source.length) {
        pushFragment(word, "\\", "none");
        i++;
      } else if (source[i + 1] === "\n") {
        i += 2;
      } else {
        pushFragment(word, `\u0000${source[i + 1]}`, "none");
        i += 2;
      }
      continue;
    }

    const word = ensureWord();
    let text = "";
    while (i < source.length) {
      const c = source[i];
      if ((c === "$" && ["(", "{"].includes(source[i + 1])) || c === "`") {
        const end = source[i + 1] === "{" ? parameterEnd(source, i) : substitutionEnd(source, i);
        text += source.slice(i, end);
        i = end;
        continue;
      }
      const maybeOp =
        ["|", ";", "<", ">"].includes(c) ||
        source.slice(i, i + 2) === "&&" ||
        source.slice(i, i + 2) === "||" ||
        source.slice(i, i + 2) === "2>";
      if (isSpace(c) || c === "\n" || c === "'" || c === '"' || c === "\\" || maybeOp)
        break;
      text += c;
      i++;
    }
    pushFragment(word, text, "none");
  }

  finishWord();
  return tokens;
}

function emptyCommand() {
  return { words: [], redirects: [] };
}

export function parse(source) {
  const tokens = tokenize(source);
  const jobs = [];
  let i = 0;
  let connector = null;

  const skipSemicolons = () => {
    while (tokens[i]?.type === "op" && tokens[i].value === ";") i++;
  };

  skipSemicolons();
  while (i < tokens.length) {
    const pipeline = [];
    while (true) {
      const command = emptyCommand();
      while (i < tokens.length) {
        const token = tokens[i];
        if (token.type === "op" && ["|", ";", "&&", "||"].includes(token.value))
          break;
        if (token.type === "op" && ["<", ">", ">>", "2>", "2>>"].includes(token.value)) {
          const target = tokens[i + 1];
          if (!target || target.type !== "word")
            throw new ShellSyntaxError(`redirection ${token.value} requires a path`, token.offset);
          command.redirects.push({ op: token.value, target });
          i += 2;
          continue;
        }
        if (token.type !== "word")
          throw new ShellSyntaxError(`unexpected operator ${token.value}`, token.offset);
        command.words.push(token);
        i++;
      }
      if (command.words.length === 0 && command.redirects.length === 0)
        throw new ShellSyntaxError("expected a command", tokens[i]?.offset ?? source.length);
      pipeline.push(command);

      if (tokens[i]?.value === "|") {
        i++;
        if (!tokens[i])
          throw new ShellSyntaxError("pipeline requires a command", source.length);
        continue;
      }
      break;
    }

    jobs.push({ connector, pipeline });
    const separator = tokens[i]?.value;
    if (!separator) break;
    if (![";", "&&", "||"].includes(separator))
      throw new ShellSyntaxError(`unexpected operator ${separator}`, tokens[i].offset);
    connector = separator;
    i++;
    skipSemicolons();
    if (i >= tokens.length) break;
  }
  return jobs;
}

function parameterValue(name, state) {
  if (name === "?") return String(state.lastStatus);
  if (name === "$") return String(process.pid);
  if (name === "#") return String(Math.max(0, state.args.length - 1));
  if (name === "-") return "";
  if (name === "0") return state.args[0] ?? "bunmsh";
  if (name === "@" || name === "*") return state.args.slice(1).join((state.env.IFS ?? " ")[0] ?? " ");
  if (/^[1-9][0-9]*$/.test(name)) return state.args[Number(name)] ?? "";
  return state.env[name] ?? "";
}

function tildeDirectory(name, state) {
  if (name === "") return state.env.HOME ?? "";
  if (name === "+") return state.env.PWD ?? state.cwd;
  if (name === "-") return state.env.OLDPWD ?? "~-";
  try {
    const entry = readFileSync("/etc/passwd", "utf8").split("\n")
      .find((line) => line.split(":", 2)[0] === name);
    return entry?.split(":")[5] ?? `~${name}`;
  } catch { return `~${name}`; }
}

function expandTildes(text, state, assignment) {
  const pattern = assignment ? /(^|[=:])~([A-Za-z0-9_.+-]*)(?=\/|:|$)/g : /^~([A-Za-z0-9_.+-]*)(?=\/|$)/;
  if (assignment)
    return text.replace(pattern, (_match, prefix, name) => `${prefix}${tildeDirectory(name, state)}`);
  return text.replace(pattern, (_match, name) => tildeDirectory(name, state));
}

function arithmeticValue(source, state) {
  const tokens = source.match(/(?:0[xX][0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\|\||&&|==|!=|<=|>=|<<|>>|[()+\-*/%<>&^|!~])/g) ?? [];
  let i = 0;
  const precedence = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6,
    "<": 7, "<=": 7, ">": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9,
    "*": 10, "/": 10, "%": 10 };
  const atom = () => {
    const token = tokens[i++];
    if (["+", "-", "!", "~"].includes(token)) {
      const value = atom();
      return token === "+" ? value : token === "-" ? -value : token === "!" ? Number(!value) : ~value;
    }
    if (token === "(") {
      const value = expression(0);
      if (tokens[i++] !== ")") throw new ShellSyntaxError("bad arithmetic expression");
      return value;
    }
    if (/^[A-Za-z_]/.test(token ?? "")) return Number(state.env[token] ?? 0) || 0;
    if (token === undefined) throw new ShellSyntaxError("bad arithmetic expression");
    return Number(token);
  };
  const expression = (minimum) => {
    let left = atom();
    while ((precedence[tokens[i]] ?? -1) >= minimum) {
      const op = tokens[i++], priority = precedence[op], right = expression(priority + 1);
      left = { "||": Number(Boolean(left || right)), "&&": Number(Boolean(left && right)),
        "|": left | right, "^": left ^ right, "&": left & right, "==": Number(left === right),
        "!=": Number(left !== right), "<": Number(left < right), "<=": Number(left <= right),
        ">": Number(left > right), ">=": Number(left >= right), "<<": left << right,
        ">>": left >> right, "+": left + right, "-": left - right, "*": left * right,
        "/": Math.trunc(left / right), "%": left % right }[op];
    }
    return left;
  };
  const value = expression(0);
  if (i !== tokens.length || !Number.isFinite(value)) throw new ShellSyntaxError("bad arithmetic expression");
  return String(value | 0);
}

function globPatternRegex(pattern, anchoredStart, anchoredEnd, greedy) {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") source += greedy ? ".*" : ".*?";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${anchoredStart ? "^" : ""}${source}${anchoredEnd ? "$" : ""}`);
}

async function parameterExpansion(body, state) {
  if (/^[!%][A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
    const value = parameterValue(body.slice(1), state);
    return body[0] === "!" ? parameterValue(value, state) : String([...value].length);
  }
  if (body.startsWith("#") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.slice(1)))
    return String(parameterValue(body.slice(1), state).length);
  const trim = /^([A-Za-z_][A-Za-z0-9_]*|[?$#@*]|[0-9]+)(%%|%|##|#)(.*)$/s.exec(body);
  if (trim) {
    const value = parameterValue(trim[1], state);
    const pattern = stripExpansionMarkers(await expandText(trim[3], state));
    const matches = (part) => globPatternRegex(pattern, true, true, true).test(part);
    if (trim[2] === "%") {
      for (let i = value.length; i >= 0; i--) if (matches(value.slice(i))) return value.slice(0, i);
    } else if (trim[2] === "%%") {
      for (let i = 0; i <= value.length; i++) if (matches(value.slice(i))) return value.slice(0, i);
    } else if (trim[2] === "#") {
      for (let i = 0; i <= value.length; i++) if (matches(value.slice(0, i))) return value.slice(i);
    } else {
      for (let i = value.length; i >= 0; i--) if (matches(value.slice(0, i))) return value.slice(i);
    }
    return value;
  }
  const replace = /^([A-Za-z_][A-Za-z0-9_]*|[?$#@*-]|[0-9]+)\/(\/|#|%)?([^/]*)\/(.*)$/s.exec(body);
  if (replace) {
    const value = parameterValue(replace[1], state);
    const pattern = stripExpansionMarkers(await expandText(replace[3], state));
    const replacement = stripExpansionMarkers(await expandText(replace[4], state));
    let source = "";
    for (const ch of pattern) {
      if (ch === "*") source += ".*";
      else if (ch === "?") source += ".";
      else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
    const prefix = replace[2] === "#" ? "^" : "";
    const suffix = replace[2] === "%" ? "$" : "";
    return value.replace(new RegExp(`${prefix}${source}${suffix}`, replace[2] === "/" ? "g" : ""), replacement);
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*|[?$#@*-]|[0-9]+)(?:(:?[-+=?])(.*))?$/s.exec(body);
  if (!match) throw new ShellSyntaxError(`unsupported parameter expansion: \${${body}}`);
  const [, name, operator, operand = ""] = match;
  const value = parameterValue(name, state);
  const unset = !Object.hasOwn(state.env, name) && !/^[?$#@*0-9]$/.test(name);
  const empty = value === "";
  if (!operator) return value;
  const useEmpty = operator.startsWith(":");
  const op = operator.at(-1);
  const missing = unset || (useEmpty && empty);
  const expandedOperand = async () => stripExpansionMarkers(await expandText(operand, state));
  if (op === "-") return missing ? expandedOperand() : value;
  if (op === "+") return missing ? "" : expandedOperand();
  if (op === "=") {
    if (missing) {
      if (!/^[A-Za-z_]/.test(name)) throw new ShellSyntaxError("cannot assign positional parameter");
      if (state.readonly?.has(name)) throw new ShellSyntaxError(`${name}: is read only`);
      const expanded = await expandedOperand();
      state.env[name] = expanded;
      return expanded;
    }
    return value;
  }
  if (op === "?" && missing) throw new ShellSyntaxError(operand ? await expandedOperand() : `${name}: parameter null or not set`);
  return value;
}

function markedExpansion(value) {
  return `\u0001${value}\u0002`;
}

function stripExpansionMarkers(value) {
  return value.replace(/[\u0001\u0002]/g, "");
}

async function commandSubstitution(source, state) {
  const child = {
    ...state,
    env: { ...state.env },
    aliases: { ...state.aliases },
    readonly: new Set(state.readonly),
    directoryHistory: [...state.directoryHistory],
    exitRequested: false,
    exitStatus: 0,
  };
  const output = await execute(source, child, { capture: true });
  state.expansionStatus = output.status;
  return decode(output.stdout).replace(/\n+$/, "");
}

async function expandText(text, state) {
  let output = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\u0000") {
      output += `\u0000${text[i + 1] ?? ""}`;
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = substitutionEnd(text, i);
      output += markedExpansion(await commandSubstitution(text.slice(i + 1, end - 1), state));
      i = end;
      continue;
    }
    if (text[i] !== "$") {
      output += text[i++];
      continue;
    }
    if (text.startsWith("$((", i)) {
      const end = substitutionEnd(text, i);
      output += markedExpansion(arithmeticValue(text.slice(i + 3, end - 2), state));
      i = end;
      continue;
    }
    if (text.startsWith("$(", i)) {
      const end = substitutionEnd(text, i);
      output += markedExpansion(await commandSubstitution(text.slice(i + 2, end - 1), state));
      i = end;
      continue;
    }
    if (text[i + 1] === "{") {
      const end = parameterEnd(text, i);
      output += markedExpansion(await parameterExpansion(text.slice(i + 2, end - 1), state));
      i = end;
      continue;
    }
    const next = text[i + 1];
    if (["?", "$", "#", "@", "*", "-"].includes(next) || /[0-9]/.test(next ?? "")) {
      output += markedExpansion(parameterValue(next, state));
      i += 2;
      continue;
    }
    if (isNameStart(next)) {
      let end = i + 2;
      while (isNameChar(text[end])) end++;
      output += markedExpansion(parameterValue(text.slice(i + 1, end), state));
      i = end;
      continue;
    }
    output += "$";
    i++;
  }
  return output;
}

function splitFields(segments, state) {
  const ifs = state.env.IFS === undefined ? " \t\n" : state.env.IFS;
  const fields = [];
  let current = [];
  let forced = false;
  let afterWhitespaceDelimiter = false;
  const finish = (includeEmpty = false) => {
    if (current.length || forced || includeEmpty) fields.push(current);
    current = [];
    forced = false;
  };
  for (const segment of segments) {
    if (segment.quoted && segment.text === "") forced = true;
    for (const ch of segment.text) {
      if (!segment.quoted && segment.splittable && ifs.includes(ch)) {
        const whitespace = " \t\n".includes(ch);
        finish(!whitespace && !afterWhitespaceDelimiter);
        afterWhitespaceDelimiter = whitespace;
      } else {
        current.push({ ch, quoted: segment.quoted });
        afterWhitespaceDelimiter = false;
      }
    }
  }
  finish();
  return fields;
}

async function pathnameFields(field, state) {
  const value = field.map(({ ch }) => ch).join("");
  if (!field.some(({ ch, quoted }) => !quoted && "*?[".includes(ch))) return [value];
  const pattern = field.map(({ ch, quoted }) => {
    if (!quoted) return ch;
    if (ch === "*") return "[*]";
    if (ch === "?") return "[?]";
    if (ch === "[") return "[[]";
    return ch;
  }).join("");
  const glob = new Bun.Glob(pattern);
  const matches = [...glob.scanSync({ cwd: state.cwd, dot: false, onlyFiles: false })].sort();
  return matches.length ? matches : [value];
}

function braceFields(field) {
  let open = -1;
  for (let i = 0; i < field.length; i++) {
    if (!field[i].quoted && field[i].ch === "{") { open = i; break; }
  }
  if (open < 0) return [field];
  let depth = 0, close = -1;
  const commas = [];
  for (let i = open; i < field.length; i++) {
    if (field[i].quoted) continue;
    if (field[i].ch === "{") depth++;
    else if (field[i].ch === "}" && --depth === 0) { close = i; break; }
    else if (field[i].ch === "," && depth === 1) commas.push(i);
  }
  if (close < 0 || commas.length === 0) return [field];
  const boundaries = [open, ...commas, close];
  const output = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const replacement = field.slice(boundaries[i] + 1, boundaries[i + 1]);
    output.push(...braceFields([...field.slice(0, open), ...replacement, ...field.slice(close + 1)]));
  }
  return output;
}

export async function expandWord(word, state, options = {}) {
  if (!options.single && word.fragments.length === 1 &&
      word.fragments[0].quote === "double" && word.fragments[0].text === "$@")
    return state.args.slice(1);
  const segments = [];
  for (let index = 0; index < word.fragments.length; index++) {
    const fragment = word.fragments[index];
    const source = fragment.quote === "none"
      ? expandTildes(fragment.text, state, Boolean(options.assignment))
      : fragment.text;
    let text = fragment.quote === "single"
      ? source.replaceAll("\u0000", "")
      : await expandText(source, state);
    if (fragment.quote !== "none") {
      segments.push({ text: stripExpansionMarkers(text.replaceAll("\u0000", "")), quoted: true, splittable: false });
    } else {
      let plain = "";
      let splittable = false;
      const flush = () => {
        if (plain) segments.push({ text: plain, quoted: false, splittable });
        plain = "";
      };
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\u0001") { flush(); splittable = true; continue; }
        if (text[i] === "\u0002") { flush(); splittable = false; continue; }
        if (text[i] !== "\u0000") { plain += text[i]; continue; }
        flush();
        segments.push({ text: text[++i] ?? "", quoted: true, splittable: false });
      }
      flush();
    }
  }
  if (options.single) return [segments.map(({ text }) => text).join("")];
  const fields = splitFields(segments, state);
  const output = [];
  for (const field of fields)
    for (const expanded of braceFields(field)) output.push(...await pathnameFields(expanded, state));
  return output;
}

function splitAssignment(value) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
  return match ? { name: match[1], value: match[2] } : null;
}

function bytes(value = "") {
  return value instanceof Uint8Array ? value : encoder.encode(String(value));
}

function concatBytes(parts) {
  const values = parts.map(bytes);
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout: bytes(stdout), stderr: bytes(stderr) };
}

function quoteShellWord(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function findExecutable(name, state, defaultPath = false) {
  const path = defaultPath ? DEFAULT_COMMAND_PATH : (state.env.PATH ?? "");
  return Bun.which(name, { PATH: path, cwd: state.cwd });
}

function aliasWords(value) {
  const tokens = tokenize(value);
  if (tokens.some((token) => token.type !== "word")) return null;
  return tokens.map((token) => token.fragments
    .map((fragment) => fragment.text.replaceAll("\u0000", ""))
    .join(""));
}

function readonlyError(name) {
  return result(1, "", `bunmsh: ${name}: is read only\n`);
}

function writeStream(stream, data) {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => error ? reject(error) : resolve());
  });
}

function parsePrintEscapes(value) {
  let stop = false;
  const text = value.replace(/\\(c|n|r|t|b|a|v|\\|0[0-7]{1,3})/g, (_, code) => {
    if (code === "c") {
      stop = true;
      return "";
    }
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", a: "\x07", v: "\v", "\\": "\\" };
    if (code[0] === "0") return String.fromCharCode(parseInt(code.slice(1), 8));
    return map[code] ?? code;
  });
  return { text, stop };
}

function parentDirectory(path) {
  if (path === "/") return "/";
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  const separator = path.lastIndexOf("/", end - 1);
  return separator <= 0 ? "/" : path.slice(0, separator);
}

async function changeDirectory(state, target, { print = false } = {}) {
  const path = target.startsWith("/") ? target : `${state.cwd}/${target}`;
  try {
    const pathname = new URL(`file://${path.replaceAll("//", "/")}`).pathname;
    const resolved = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
    const stat = await Bun.file(resolved).stat();
    if (!stat.isDirectory())
      return result(1, "", `bunmsh: cd: ${target}: not a directory\n`);
    const previous = state.cwd;
    state.directoryHistory.push(previous);
    state.cwd = resolved;
    state.env.OLDPWD = previous;
    state.env.PWD = resolved;
    return result(0, print ? `${resolved}\n` : "");
  } catch (error) {
    return result(1, "", `bunmsh: cd: ${target}: ${error.message}\n`);
  }
}

async function previousChildDirectory(state) {
  for (let i = state.directoryHistory.length - 1; i >= 0; i--) {
    const candidate = state.directoryHistory[i];
    if (parentDirectory(candidate) !== state.cwd) continue;
    try {
      if ((await Bun.file(candidate).stat()).isDirectory())
        return changeDirectory(state, candidate);
    } catch {}
  }
  return result(1, "", "bunmsh: //: no previous child directory\n");
}

async function sourceFile(argv, state) {
  if (!argv[1]) return result(2, "", `bunmsh: ${argv[0]}: missing file operand\n`);
  let path = argv[1];
  if (!path.includes("/")) {
    const found = (state.env.PATH ?? "").split(":")
      .map((directory) => resolvePath(directory || state.cwd, path))
      .find((candidate) => {
        try { return statSync(candidate).isFile(); } catch { return false; }
      });
    if (found) path = found;
  } else if (!isAbsolute(path)) path = resolvePath(state.cwd, path);
  try {
    const source = await Bun.file(path).text();
    const previousArgs = state.args;
    if (argv.length > 2) state.args = [previousArgs[0], ...argv.slice(2)];
    try {
      return await execute(source, state, { capture: true });
    } finally {
      state.args = previousArgs;
    }
  } catch (error) {
    return result(1, "", `bunmsh: ${argv[0]}: ${argv[1]}: ${error.message}\n`);
  }
}

function testStat(path, state) {
  try { return statSync(isAbsolute(path) ? path : resolvePath(state.cwd, path)); }
  catch { return null; }
}

function evaluateTest(argv, state) {
  if (argv.length === 0) return false;
  if (argv[0] === "!") return !evaluateTest(argv.slice(1), state);
  const or = argv.indexOf("-o");
  if (or >= 0) return evaluateTest(argv.slice(0, or), state) || evaluateTest(argv.slice(or + 1), state);
  const and = argv.indexOf("-a");
  if (and >= 0) return evaluateTest(argv.slice(0, and), state) && evaluateTest(argv.slice(and + 1), state);
  if (argv.length === 1) return argv[0].length > 0;
  if (argv.length === 2) {
    const [op, value] = argv;
    if (op === "-n") return value.length > 0;
    if (op === "-z") return value.length === 0;
    const stat = testStat(value, state);
    if (op === "-e") return stat !== null;
    if (op === "-f") return Boolean(stat?.isFile());
    if (op === "-d") return Boolean(stat?.isDirectory());
    if (op === "-b") return Boolean(stat?.isBlockDevice());
    if (op === "-c") return Boolean(stat?.isCharacterDevice());
    if (op === "-p") return Boolean(stat?.isFIFO());
    if (op === "-S") return Boolean(stat?.isSocket());
    if (op === "-L" || op === "-h") {
      try { return lstatSync(isAbsolute(value) ? value : resolvePath(state.cwd, value)).isSymbolicLink(); }
      catch { return false; }
    }
    if (op === "-s") return Boolean(stat && stat.size > 0);
    if (op === "-r" || op === "-w" || op === "-x") {
      try {
        const mode = op === "-r" ? fsConstants.R_OK : op === "-w" ? fsConstants.W_OK : fsConstants.X_OK;
        accessSync(isAbsolute(value) ? value : resolvePath(state.cwd, value), mode);
        return true;
      } catch { return false; }
    }
    return false;
  }
  if (argv.length === 3) {
    const [left, op, right] = argv;
    if (op === "=" || op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (["-eq", "-ne", "-gt", "-ge", "-lt", "-le"].includes(op)) {
      const a = Number(left), b = Number(right);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error("integer expression expected");
      return { "-eq": a === b, "-ne": a !== b, "-gt": a > b, "-ge": a >= b,
        "-lt": a < b, "-le": a <= b }[op];
    }
    const a = testStat(left, state), b = testStat(right, state);
    if (op === "-nt") return Boolean(a && (!b || a.mtimeMs > b.mtimeMs));
    if (op === "-ot") return Boolean(b && (!a || a.mtimeMs < b.mtimeMs));
    if (op === "-ef") return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
  }
  throw new Error("unsupported expression");
}

const builtins = {
  ":": async () => result(),
  true: async () => result(),
  false: async () => result(1),
  // Execution is handled specially by runCommand so command can alter command
  // lookup without creating another parsed command.
  command: null,
  builtin: null,
  __builtin: null,
  time: null,
  whence: async (argv, state) => {
    let pathOnly = false, verbose = false, i = 1;
    for (; i < argv.length; i++) {
      if (argv[i] === "--") { i++; break; }
      if (argv[i] === "-p") pathOnly = true;
      else if (argv[i] === "-v") verbose = true;
      else if (argv[i].startsWith("-") && argv[i] !== "-")
        return result(1, "", `bunmsh: whence: ${argv[i]}: unknown option\n`);
      else break;
    }
    let status = 0, output = "";
    for (const name of argv.slice(i)) {
      let description;
      if (pathOnly) {
        const path = findExecutable(name, state);
        description = path ? `${path}\n` : null;
      } else description = describeCommand(name, state, verbose, false);
      if (description === null || description.endsWith(" not found\n")) status = 1;
      if (description) output += description;
    }
    return result(status, output);
  },
  which: async (argv, state) => {
    let i = 1;
    if (argv[i] === "--") i++;
    if (i >= argv.length)
      return result(1, "", "bunmsh: which: missing command name\n");
    let status = 0, output = "";
    for (; i < argv.length; i++) {
      const path = Bun.which(argv[i], { PATH: state.env.PATH ?? "", cwd: state.cwd });
      if (path) output += `${path}\n`;
      else status = 1;
    }
    return result(status, output);
  },
  type: async (argv, state) => {
    let status = 0, output = "";
    for (const name of argv.slice(1)) {
      const description = describeCommand(name, state, true, false);
      if (description.endsWith(" not found\n")) status = 1;
      output += description;
    }
    return result(status, output);
  },
  alias: async (argv, state) => {
    if (argv.length === 1) {
      const output = Object.entries(state.aliases)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, words]) => `alias ${name}=${quoteShellWord(words.join(" "))}\n`)
        .join("");
      return result(0, output);
    }
    let status = 0;
    let output = "";
    let stderr = "";
    for (const item of argv.slice(1)) {
      const equal = item.indexOf("=");
      if (equal < 0) {
        const words = state.aliases[item];
        if (words) output += `alias ${item}=${quoteShellWord(words.join(" "))}\n`;
        else {
          status = 1;
          stderr += `bunmsh: alias: ${item}: not found\n`;
        }
        continue;
      }
      const name = item.slice(0, equal);
      const words = aliasWords(item.slice(equal + 1));
      if (!name || words === null) {
        status = 1;
        stderr += `bunmsh: alias: ${name || item}: invalid alias\n`;
      } else state.aliases[name] = words;
    }
    return result(status, output, stderr);
  },
  unalias: async (argv, state) => {
    let i = 1;
    if (argv[i] === "-a") {
      state.aliases = {};
      return result();
    }
    if (argv[i] === "--") i++;
    if (i === argv.length)
      return result(1, "", "bunmsh: unalias: missing alias name\n");
    let status = 0;
    let stderr = "";
    for (; i < argv.length; i++) {
      if (Object.hasOwn(state.aliases, argv[i])) delete state.aliases[argv[i]];
      else {
        status = 1;
        stderr += `bunmsh: unalias: ${argv[i]}: not found\n`;
      }
    }
    return result(status, "", stderr);
  },
  test: async (argv, state) => {
    try { return result(evaluateTest(argv.slice(1), state) ? 0 : 1); }
    catch (error) { return result(2, "", `bunmsh: test: ${error.message}\n`); }
  },
  "[": async (argv, state) => {
    if (argv.at(-1) !== "]") return result(2, "", "bunmsh: [: missing ]\n");
    try { return result(evaluateTest(argv.slice(1, -1), state) ? 0 : 1); }
    catch (error) { return result(2, "", `bunmsh: [: ${error.message}\n`); }
  },
  echo: async (argv) => {
    let newline = true;
    let start = 1;
    if (argv[1] === "-n") {
      newline = false;
      start = 2;
    }
    return result(0, argv.slice(start).join(" ") + (newline ? "\n" : ""));
  },
  print: async (argv) => {
    let raw = false;
    let newline = true;
    let separator = " ";
    let terminator = "\n";
    let fd = 1;
    let i = 1;
    for (; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") {
        i++;
        break;
      }
      if (!arg.startsWith("-") || arg === "-") break;
      if (/^-u[0-9]+$/.test(arg)) {
        fd = Number(arg.slice(2));
        continue;
      }
      if (arg === "-r" || arg === "-R") raw = true;
      else if (arg === "-n") newline = false;
      else if (arg === "-l") separator = "\n";
      else if (arg === "-N") separator = terminator = "\0";
      else return result(1, "", `bunmsh: print: ${arg}: unsupported option\n`);
    }
    let output = argv.slice(i).join(separator);
    if (!raw) {
      const expanded = parsePrintEscapes(output);
      output = expanded.text;
      if (expanded.stop) newline = false;
    }
    if (newline) output += terminator;
    if (fd === 2) return result(0, "", output);
    if (fd !== 1)
      return result(1, "", `bunmsh: print: file descriptor ${fd} is not supported yet\n`);
    return result(0, output);
  },
  printf: async (argv) => {
    if (argv.length < 2) return result(2, "", "bunmsh: printf: missing format\n");
    const format = argv[1];
    let ai = 2;
    let output = "";
    for (let i = 0; i < format.length; i++) {
      if (format[i] === "\\" && i + 1 < format.length) {
        const parsed = parsePrintEscapes(format.slice(i, i + 2));
        output += parsed.text;
        i++;
        continue;
      }
      if (format[i] !== "%") {
        output += format[i];
        continue;
      }
      if (format[i + 1] === "%") {
        output += "%";
        i++;
        continue;
      }
      const match = /^%([0-9]*)([sdi])/.exec(format.slice(i));
      if (!match) return result(2, "", `bunmsh: printf: unsupported format near ${format.slice(i)}\n`);
      const width = Number(match[1] || 0);
      const kind = match[2];
      const value = argv[ai++] ?? (kind === "s" ? "" : "0");
      let rendered = kind === "s" ? value : String(Number.parseInt(value, 10) || 0);
      if (width > rendered.length)
        rendered = (match[1]?.startsWith("0") ? "0" : " ").repeat(width - rendered.length) + rendered;
      output += rendered;
      i += match[0].length - 1;
    }
    return result(0, output);
  },
  pwd: async (_argv, state) => result(0, `${state.cwd}\n`),
  cd: async (argv, state) => {
    if (argv[1] === "//") return previousChildDirectory(state);
    if (argv[1] === "-") {
      if (!state.env.OLDPWD)
        return result(1, "", "bunmsh: cd: OLDPWD is not set\n");
      return changeDirectory(state, state.env.OLDPWD, { print: true });
    }
    const target = argv[1] ?? state.env.HOME;
    if (!target) return result(1, "", "bunmsh: cd: HOME is not set\n");
    return changeDirectory(state, target);
  },
  chdir: async (argv, state) => builtins.cd(["cd", ...argv.slice(1)], state),
  "-": async (_argv, state) => builtins.cd(["cd", "-"], state),
  "~": async (_argv, state) => builtins.cd(["cd"], state),
  "..": async (_argv, state) => changeDirectory(state, ".."),
  "//": async (_argv, state) => previousChildDirectory(state),
  export: async (argv, state) => {
    if (argv.length === 1) {
      const listing = Object.entries(state.env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `export ${name}=${JSON.stringify(value)}\n`)
        .join("");
      return result(0, listing);
    }
    for (const item of argv.slice(1)) {
      const assignment = splitAssignment(item);
      if (assignment) {
        if (state.readonly.has(assignment.name)) return readonlyError(assignment.name);
        state.env[assignment.name] = assignment.value;
      }
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))
        state.env[item] ??= "";
      else return result(1, "", `bunmsh: export: ${item}: invalid name\n`);
    }
    return result();
  },
  unset: async (argv, state) => {
    let i = 1;
    if (argv[i] === "-v" || argv[i] === "--") i++;
    for (const name of argv.slice(i)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        return result(1, "", `bunmsh: unset: ${name}: invalid name\n`);
      if (state.readonly.has(name)) return readonlyError(name);
      delete state.env[name];
    }
    return result();
  },
  readonly: async (argv, state) => {
    if (argv.length === 1 || (argv.length === 2 && argv[1] === "-p")) {
      const output = [...state.readonly].sort()
        .map((name) => `readonly ${name}=${quoteShellWord(state.env[name] ?? "")}\n`)
        .join("");
      return result(0, output);
    }
    let i = argv[1] === "--" ? 2 : 1;
    for (; i < argv.length; i++) {
      const assignment = splitAssignment(argv[i]);
      const name = assignment?.name ?? argv[i];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        return result(1, "", `bunmsh: readonly: ${name}: invalid name\n`);
      if (assignment) {
        if (state.readonly.has(name)) return readonlyError(name);
        state.env[name] = assignment.value;
      } else state.env[name] ??= "";
      state.readonly.add(name);
    }
    return result();
  },
  env: async (argv, state) => {
    if (argv.length > 1)
      return result(2, "", "bunmsh: env: command arguments are not implemented yet\n");
    return result(0, Object.entries(state.env).map(([k, v]) => `${k}=${v}\n`).join(""));
  },
  exit: async (argv, state) => {
    const status = argv[1] === undefined ? state.lastStatus : Number(argv[1]);
    if (!Number.isInteger(status))
      return result(2, "", `bunmsh: exit: ${argv[1]}: numeric argument required\n`);
    state.exitRequested = true;
    state.exitStatus = status & 255;
    return result(state.exitStatus);
  },
  shift: async (argv, state) => {
    const count = argv[1] === undefined ? 1 : Number(argv[1]);
    if (!Number.isInteger(count) || count < 0)
      return result(1, "", `bunmsh: shift: ${argv[1]}: bad number\n`);
    if (count > state.args.length - 1) return result(1);
    state.args.splice(1, count);
    return result();
  },
  getopts: async (argv, state) => {
    if (argv.length < 3)
      return result(2, "", "bunmsh: getopts: usage: getopts optstring name [arg ...]\n");
    const optstring = argv[1];
    const variable = argv[2];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
      return result(2, "", `bunmsh: getopts: ${variable}: invalid name\n`);
    const args = argv.length > 3 ? argv.slice(3) : state.args.slice(1);
    let index = Number(state.env.OPTIND ?? "1");
    if (!Number.isInteger(index) || index < 1) index = 1;
    let offset = state.getoptsOffset ?? 1;
    const current = args[index - 1];
    if (!current || current === "--" || !current.startsWith("-") || current === "-") {
      if (current === "--") state.env.OPTIND = String(index + 1);
      state.getoptsOffset = 1;
      return result(1);
    }
    const option = current[offset];
    const position = optstring.indexOf(option);
    const requiresArgument = position >= 0 && optstring[position + 1] === ":";
    let stderr = "";
    delete state.env.OPTARG;
    if (position < 0 || option === ":") {
      state.env[variable] = "?";
      if (optstring[0] === ":") state.env.OPTARG = option;
      else stderr = `bunmsh: getopts: -${option}: unknown option\n`;
    } else if (requiresArgument) {
      if (offset + 1 < current.length) state.env.OPTARG = current.slice(offset + 1);
      else if (index < args.length) state.env.OPTARG = args[index++];
      else {
        state.env[variable] = optstring[0] === ":" ? ":" : "?";
        if (optstring[0] === ":") state.env.OPTARG = option;
        else stderr = `bunmsh: getopts: -${option}: argument expected\n`;
        state.env.OPTIND = String(index + 1);
        state.getoptsOffset = 1;
        return result(0, "", stderr);
      }
      state.env[variable] = option;
      offset = current.length;
    } else state.env[variable] = option;
    if (offset + 1 >= current.length) {
      index++;
      offset = 1;
    } else offset++;
    state.env.OPTIND = String(index);
    state.getoptsOffset = offset;
    return result(0, "", stderr);
  },
  eval: async (argv, state) => execute(argv.slice(1).join(" "), state, { capture: true }),
  ".": async (argv, state) => sourceFile(argv, state),
  source: async (argv, state) => sourceFile(argv, state),
  realpath: async (argv, state) => {
    let output = "";
    try {
      for (const item of argv.slice(1))
        output += `${realpathSync(isAbsolute(item) ? item : resolvePath(state.cwd, item))}\n`;
      return result(0, output);
    } catch (error) {
      return result(1, "", `bunmsh: realpath: ${error.message}\n`);
    }
  },
  umask: async (argv) => {
    if (argv.length === 1) return result(0, `${process.umask().toString(8).padStart(4, "0")}\n`);
    if (argv.length !== 2 || !/^[0-7]{1,4}$/.test(argv[1]))
      return result(1, "", "bunmsh: umask: bad mask\n");
    process.umask(Number.parseInt(argv[1], 8));
    return result();
  },
  kill: async (argv) => {
    let signal = "SIGTERM";
    let i = 1;
    if (argv[i] === "-l") {
      const names = Object.keys(osConstants.signals).map((name) => name.replace(/^SIG/, ""));
      return result(0, `${names.join(" ")}\n`);
    }
    if (argv[i]?.startsWith("-") && argv[i] !== "-") {
      const value = argv[i++].slice(1).toUpperCase();
      signal = /^\d+$/.test(value) ? Number(value) : `SIG${value.replace(/^SIG/, "")}`;
    }
    if (i >= argv.length) return result(2, "", "bunmsh: kill: missing pid\n");
    let status = 0, stderr = "";
    for (; i < argv.length; i++) {
      const pid = Number(argv[i]);
      try { process.kill(pid, signal); }
      catch (error) { status = 1; stderr += `bunmsh: kill: ${argv[i]}: ${error.message}\n`; }
    }
    return result(status, "", stderr);
  },
  set: async (argv, state) => {
    if (argv.length === 1)
      return result(0, Object.entries(state.env).sort().map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(""));
    return result(2, "", "bunmsh: set: option handling is not implemented yet\n");
  },
};

// These are used only when PATH does not provide an executable of the same
// name. `builtin name` can still select them explicitly.
const fallbackBuiltins = {
  basename: async (argv) => {
    const i = argv[1] === "--" ? 2 : 1;
    if (i >= argv.length || argv.length - i > 2)
      return result(1, "", "bunmsh: basename: usage: basename string [suffix]\n");
    let name = pathBasename(argv[i]);
    const suffix = argv[i + 1];
    if (suffix && suffix !== name && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    return result(0, `${name}\n`);
  },
  dirname: async (argv) => {
    const i = argv[1] === "--" ? 2 : 1;
    if (argv.length - i !== 1)
      return result(1, "", "bunmsh: dirname: usage: dirname string\n");
    return result(0, `${pathDirname(argv[i])}\n`);
  },
};

function builtinNames() {
  return [...new Set([...Object.keys(builtins), ...Object.keys(fallbackBuiltins)])].sort();
}

function formatMilliseconds(milliseconds, color = Boolean(process.stderr.isTTY)) {
  const rendered = milliseconds.toFixed(6);
  if (!color) return rendered;
  const decimal = rendered.indexOf(".");
  const palette = [46, 82, 118, 154, 190, 226, 220, 214, 208, 202, 196, 198, 201, 165, 129, 93, 57, 21, 27, 33, 39, 45];
  let output = "";
  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i] === ".") {
      output += "\x1b[2m.\x1b[0m";
      continue;
    }
    const magnitude = i < decimal ? decimal - i - 1 : decimal - i;
    const index = ((magnitude % palette.length) + palette.length) % palette.length;
    output += `\x1b[38;5;${palette[index]}m${rendered[i]}\x1b[0m`;
  }
  return output;
}

export function createState(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const cwd = options.cwd ?? process.cwd();
  env.PWD = cwd;
  return {
    env,
    cwd,
    directoryHistory: [...(options.directoryHistory ?? [])],
    aliases: { ...DEFAULT_ALIASES, ...(options.aliases ?? {}) },
    readonly: new Set(options.readonly ?? []),
    getoptsOffset: 1,
    args: options.args ?? ["bunmsh"],
    lastStatus: 0,
    exitRequested: false,
    exitStatus: 0,
  };
}

async function runExternal(argv, state, input, captureStdout, captureStderr) {
  const options = {
    cmd: argv,
    cwd: state.cwd,
    env: state.env,
    stdin: input === null ? "inherit" : input,
    stdout: captureStdout ? "pipe" : "inherit",
    stderr: captureStderr ? "pipe" : "inherit",
  };
  try {
    const proc = Bun.spawn(options);
    const outputPromise = captureStdout
      ? new Response(proc.stdout).arrayBuffer()
      : Promise.resolve(new ArrayBuffer(0));
    const errorPromise = captureStderr
      ? new Response(proc.stderr).arrayBuffer()
      : Promise.resolve(new ArrayBuffer(0));
    const [status, output, error] = await Promise.all([
      proc.exited,
      outputPromise,
      errorPromise,
    ]);
    return result(status, new Uint8Array(output), new Uint8Array(error));
  } catch (error) {
    return result(127, "", `bunmsh: ${argv[0]}: ${error.message}\n`);
  }
}

function parseCommandOptions(argv) {
  let defaultPath = false;
  let query = null;
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    for (const option of arg.slice(1)) {
      if (option === "p") defaultPath = true;
      else if (option === "v" || option === "V") query = option;
      else return { error: option };
    }
  }
  return { defaultPath, query, operands: argv.slice(i) };
}

function describeCommand(name, state, verbose, defaultPath) {
  const alias = state.aliases[name];
  if (alias) {
    const definition = quoteShellWord(alias.join(" "));
    return verbose
      ? `${name} is an alias for ${definition}\n`
      : `alias ${name}=${definition}\n`;
  }
  if (Object.hasOwn(builtins, name))
    return verbose ? `${name} is a shell builtin\n` : `${name}\n`;
  const path = findExecutable(name, state, defaultPath);
  if (path) return verbose ? `${name} is ${path}\n` : `${path}\n`;
  if (Object.hasOwn(fallbackBuiltins, name))
    return verbose ? `${name} is a fallback shell builtin\n` : `${name}\n`;
  return verbose ? `${name} not found\n` : null;
}

async function runCommandArgv(argv, state, input, captureStdout, captureStderr) {
  let commandArgv = argv;
  let commandState = state;
  while (["command", "builtin", "__builtin"].includes(commandArgv[0])) {
    if (commandArgv[0] !== "command") {
      const builtinName = commandArgv[0];
      const start = commandArgv[1] === "--" ? 2 : 1;
      if (start >= commandArgv.length) {
        if (builtinName === "builtin")
          return result(0, `${builtinNames().join("\n")}\n`);
        return result();
      }
      commandArgv = commandArgv.slice(start);
      if (!Object.hasOwn(builtins, commandArgv[0]) &&
          !Object.hasOwn(fallbackBuiltins, commandArgv[0]))
        return result(1, "", `bunmsh: builtin: ${commandArgv[0]}: not found\n`);
      if (!["command", "builtin", "__builtin", "time"].includes(commandArgv[0]))
        return (builtins[commandArgv[0]] ?? fallbackBuiltins[commandArgv[0]])(
          commandArgv,
          commandState,
          input,
        );
      continue;
    }
    const parsed = parseCommandOptions(commandArgv);
    if (parsed.error)
      return result(1, "", `bunmsh: command: -${parsed.error}: unknown option\n`);
    if (parsed.query) {
      let status = 0;
      let output = "";
      for (const name of parsed.operands) {
        const description = describeCommand(
          name,
          commandState,
          parsed.query === "V",
          parsed.defaultPath,
        );
        if (description === null || description.endsWith(" not found\n")) status = 1;
        if (description !== null) output += description;
        if (status && parsed.query === "v") break;
      }
      return result(status, output);
    }
    if (parsed.operands.length === 0) return result();
    commandArgv = parsed.operands;
    if (parsed.defaultPath) {
      commandState = { ...commandState, env: { ...commandState.env, PATH: DEFAULT_COMMAND_PATH } };
    }
  }
  if (commandArgv[0] === "time") {
    const started = Bun.nanoseconds();
    const execution = commandArgv.length === 1
      ? result()
      : await runCommandArgv(
          commandArgv.slice(1),
          commandState,
          input,
          captureStdout,
          captureStderr,
        );
    const milliseconds = (Bun.nanoseconds() - started) / 1_000_000;
    execution.stderr = concatBytes([
      execution.stderr,
      `real ${formatMilliseconds(milliseconds)} ms\n`,
    ]);
    return execution;
  }
  if (Object.hasOwn(builtins, commandArgv[0]))
    return builtins[commandArgv[0]](commandArgv, commandState, input);
  if (!commandArgv[0].includes("/") && Object.hasOwn(fallbackBuiltins, commandArgv[0]) &&
      !findExecutable(commandArgv[0], commandState))
    return fallbackBuiltins[commandArgv[0]](commandArgv, commandState, input);
  return runExternal(commandArgv, commandState, input, captureStdout, captureStderr);
}

async function writeRedirect(path, data, append) {
  if (!append) {
    await Bun.write(path, data);
    return;
  }
  const file = Bun.file(path);
  const previous = await file.exists() ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  await Bun.write(path, concatBytes([previous, data]));
}

async function runCommand(command, state, options = {}) {
  state.expansionStatus = null;
  const standaloneTilde =
    command.words.length === 1 &&
    command.words[0].fragments.length === 1 &&
    command.words[0].fragments[0].quote === "none" &&
    command.words[0].fragments[0].text === "~";
  let assignmentPrefix = true;
  let aliasEligible = false;
  const expanded = standaloneTilde ? ["~"] : [];
  if (!standaloneTilde) {
    for (const word of command.words) {
      const literal = word.fragments.map((fragment) => fragment.text.replaceAll("\u0000", "")).join("");
      const assignment = assignmentPrefix && /^[A-Za-z_][A-Za-z0-9_]*=/.test(literal);
      expanded.push(...await expandWord(word, state, { single: assignment, assignment }));
      if (!assignment) {
        if (assignmentPrefix)
          aliasEligible = word.fragments.every((fragment) =>
            fragment.quote === "none" && !fragment.text.includes("\u0000"));
        assignmentPrefix = false;
      }
    }
  }
  const localEnv = {};
  while (expanded.length) {
    const assignment = splitAssignment(expanded[0]);
    if (!assignment) break;
    localEnv[assignment.name] = assignment.value;
    expanded.shift();
  }
  if (expanded.length === 0) {
    for (const name of Object.keys(localEnv))
      if (state.readonly.has(name)) return readonlyError(name);
    Object.assign(state.env, localEnv);
    return result(state.expansionStatus ?? 0);
  }
  const alias = aliasEligible ? state.aliases[expanded[0]] : null;
  if (alias) expanded.splice(0, 1, ...alias);

  let input = options.input ?? null;
  let stdoutPath = null;
  let stdoutAppend = false;
  let stderrPath = null;
  let stderrAppend = false;
  for (const redirect of command.redirects) {
    const targets = await expandWord(redirect.target, state, { single: true });
    const target = targets[0];
    const path = target.startsWith("/") ? target : `${state.cwd}/${target}`;
    if (redirect.op === "<") {
      try {
        input = new Uint8Array(await Bun.file(path).arrayBuffer());
      } catch (error) {
        return result(1, "", `bunmsh: ${target}: ${error.message}\n`);
      }
    } else if (redirect.op === ">" || redirect.op === ">>") {
      stdoutPath = path;
      stdoutAppend = redirect.op === ">>";
    } else {
      stderrPath = path;
      stderrAppend = redirect.op === "2>>";
    }
  }

  const commandState = options.subshell
    ? {
        ...state,
        env: { ...state.env, ...localEnv },
        directoryHistory: [...state.directoryHistory],
        readonly: new Set(state.readonly),
      }
    : state;
  if (!options.subshell) {
    for (const name of Object.keys(localEnv))
      if (commandState.readonly.has(name)) return readonlyError(name);
    Object.assign(commandState.env, localEnv);
  }

  const captureStdout = options.captureStdout || stdoutPath !== null;
  const captureStderr = options.captureStderr || stderrPath !== null;
  const execution = await runCommandArgv(
    expanded,
    commandState,
    input,
    captureStdout,
    captureStderr,
  );

  if (stdoutPath !== null) {
    try {
      await writeRedirect(stdoutPath, execution.stdout, stdoutAppend);
      execution.stdout = new Uint8Array();
    } catch (error) {
      return result(1, "", `bunmsh: ${stdoutPath}: ${error.message}\n`);
    }
  }
  if (stderrPath !== null) {
    try {
      await writeRedirect(stderrPath, execution.stderr, stderrAppend);
      execution.stderr = new Uint8Array();
    } catch (error) {
      return result(1, "", `bunmsh: ${stderrPath}: ${error.message}\n`);
    }
  }
  return execution;
}

async function runPipeline(pipeline, state, options = {}) {
  let input = null;
  let final = result();
  for (let i = 0; i < pipeline.length; i++) {
    const last = i === pipeline.length - 1;
    final = await runCommand(pipeline[i], state, {
      input,
      captureStdout: !last || Boolean(options.capture),
      captureStderr: Boolean(options.capture),
      subshell: pipeline.length > 1,
    });
    if (!last) input = final.stdout;
  }
  return final;
}

export async function execute(source, state = createState(), io = {}) {
  let jobs;
  try {
    jobs = parse(source);
  } catch (error) {
    const message = error instanceof ShellSyntaxError ? error.message : String(error);
    const output = `bunmsh: syntax error: ${message}\n`;
    if (io.capture) return result(2, "", output);
    console.error(output.trimEnd());
    state.lastStatus = 2;
    return result(2);
  }

  let execution = result(state.lastStatus);
  const capturedStdout = [];
  const capturedStderr = [];
  for (const job of jobs) {
    if (job.connector === "&&" && execution.status !== 0) continue;
    if (job.connector === "||" && execution.status === 0) continue;
    execution = await runPipeline(job.pipeline, state, { capture: io.capture });
    state.lastStatus = execution.status;
    if (execution.stdout.byteLength) {
      if (io.capture) capturedStdout.push(execution.stdout);
      else await writeStream(process.stdout, execution.stdout);
    }
    if (execution.stderr.byteLength) {
      if (io.capture) capturedStderr.push(execution.stderr);
      else await writeStream(process.stderr, execution.stderr);
    }
    if (state.exitRequested) break;
  }
  return io.capture
    ? result(execution.status, concatBytes(capturedStdout), concatBytes(capturedStderr))
    : execution;
}

export function decode(data) {
  return decoder.decode(data);
}
