import { expect, test } from "bun:test";
import { runGrep } from "../src/grep.js";

function input(parts) {
  return () => new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(Buffer.from(part));
      controller.close();
    },
  });
}

test("-I classifies the initial bytes before publishing matches across chunks", async () => {
  for (const parts of [["match\n", "later\0data\n"], ["match\nlater\0data\n"]]) {
    for (const options of [[], ["-c"], ["-l"], ["-q"]]) {
      const result = await runGrep(["grep", "-I", ...options, "match"], { input: input(parts) });
      expect(result).toEqual({ status: 1, stdout: options.includes("-c") ? "0\n" : "", stderr: "" });
    }
  }
});

test("-I stays streaming after a bounded binary probe", async () => {
  const prefix = "x".repeat(32767) + "\n";
  const result = await runGrep(["grep", "-Ic", "match"], { input: input([prefix, "match\n", "\0"]) });
  expect(result).toEqual({ status: 0, stdout: "1\n", stderr: "" });
});

test("-c -m0 prints zero and preserves requested labels without reading input", async () => {
  expect(await runGrep(["grep", "-c", "-m0", "match"], { input: input([]) }))
    .toEqual({ status: 1, stdout: "0\n", stderr: "" });
  expect(await runGrep(["grep", "-Hc", "-m0", "match"], { input: input([]) }))
    .toEqual({ status: 1, stdout: "(standard input):0\n", stderr: "" });
  expect(await runGrep(["grep", "-lc", "-m0", "match"], { input: input([]) }))
    .toEqual({ status: 1, stdout: "", stderr: "" });
});
