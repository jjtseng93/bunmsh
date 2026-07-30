const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_ALIASES = {
  ls: ["ls", "--color=auto"],
  diff: ["diff", "--color=auto"],
  grep: ["grep", "--color=auto"],
};

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
  if (name === "0") return state.args[0] ?? "bunmsh";
  if (/^[1-9]$/.test(name)) return state.args[Number(name)] ?? "";
  return state.env[name] ?? "";
}

function expandText(text, state) {
  let output = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\u0000") {
      output += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (text[i] !== "$") {
      output += text[i++];
      continue;
    }
    if (text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end === -1)
        throw new ShellSyntaxError("unterminated parameter expansion");
      const name = text.slice(i + 2, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$|^[?$#0-9]$/.test(name))
        throw new ShellSyntaxError(`unsupported parameter expansion: \${${name}}`);
      output += parameterValue(name, state);
      i = end + 1;
      continue;
    }
    const next = text[i + 1];
    if (["?", "$", "#"].includes(next) || /[0-9]/.test(next ?? "")) {
      output += parameterValue(next, state);
      i += 2;
      continue;
    }
    if (isNameStart(next)) {
      let end = i + 2;
      while (isNameChar(text[end])) end++;
      output += parameterValue(text.slice(i + 1, end), state);
      i = end;
      continue;
    }
    output += "$";
    i++;
  }
  return output;
}

export function expandWord(word, state) {
  let result = "";
  let quoted = false;
  for (const fragment of word.fragments) {
    quoted ||= fragment.quote !== "none";
    result += fragment.quote === "single"
      ? fragment.text.replaceAll("\u0000", "")
      : expandText(fragment.text, state);
  }
  if (!quoted && result.startsWith("~") && (result.length === 1 || result[1] === "/"))
    result = `${state.env.HOME ?? ""}${result.slice(1)}`;
  return result;
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

const builtins = {
  ":": async () => result(),
  true: async () => result(),
  false: async () => result(1),
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
      if (assignment) state.env[assignment.name] = assignment.value;
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))
        state.env[item] ??= "";
      else return result(1, "", `bunmsh: export: ${item}: invalid name\n`);
    }
    return result();
  },
  unset: async (argv, state) => {
    for (const name of argv.slice(1)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        return result(1, "", `bunmsh: unset: ${name}: invalid name\n`);
      delete state.env[name];
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
  set: async (argv, state) => {
    if (argv.length === 1)
      return result(0, Object.entries(state.env).sort().map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(""));
    return result(2, "", "bunmsh: set: option handling is not implemented yet\n");
  },
};

export function createState(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const cwd = options.cwd ?? process.cwd();
  env.PWD = cwd;
  return {
    env,
    cwd,
    directoryHistory: [...(options.directoryHistory ?? [])],
    aliases: { ...DEFAULT_ALIASES, ...(options.aliases ?? {}) },
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
  const expanded = command.words.map((word) => expandWord(word, state));
  const localEnv = {};
  while (expanded.length) {
    const assignment = splitAssignment(expanded[0]);
    if (!assignment) break;
    localEnv[assignment.name] = assignment.value;
    expanded.shift();
  }
  if (expanded.length === 0) {
    Object.assign(state.env, localEnv);
    return result();
  }
  const alias = state.aliases[expanded[0]];
  if (alias) expanded.splice(0, 1, ...alias);

  let input = options.input ?? null;
  let stdoutPath = null;
  let stdoutAppend = false;
  let stderrPath = null;
  let stderrAppend = false;
  for (const redirect of command.redirects) {
    const target = expandWord(redirect.target, state);
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
      }
    : state;
  if (!options.subshell) Object.assign(commandState.env, localEnv);

  const captureStdout = options.captureStdout || stdoutPath !== null;
  const captureStderr = options.captureStderr || stderrPath !== null;
  let execution;
  if (builtins[expanded[0]]) {
    execution = await builtins[expanded[0]](expanded, commandState, input);
  } else {
    execution = await runExternal(expanded, commandState, input, captureStdout, captureStderr);
  }

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
