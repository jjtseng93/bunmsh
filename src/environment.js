export function environmentValue(env, name, platform = process.platform) {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function canonicalEnvironment(env, platform = process.platform) {
  const output = { ...env };
  if (platform !== "win32") return output;
  const keys = Object.keys(output).filter((key) => key.toLowerCase() === "path");
  if (keys.length) {
    const value = output[keys.at(-1)];
    for (const key of keys) delete output[key];
    output.PATH = value;
  }
  return output;
}

