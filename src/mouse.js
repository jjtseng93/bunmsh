import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

export function mouseInput(onMouse, onCursorPosition, onShortcut = () => {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const input = new Transform({
    transform(chunk, _encoding, done) {
      let source = pending + decoder.write(chunk);
      pending = "";
      source = source.replace(/\x14/g, () => { onShortcut("tab"); return ""; });
      source = source.replace(/\x1bt/g, () => { onShortcut("tab-left"); return ""; });
      source = source.replace(/\x1bl/g, () => { onShortcut("lsfancy"); return ""; });
      source = source.replace(/\x1bu/g, () => { onShortcut("lsfancy-parent"); return ""; });
      let output = "";
      while (source) {
        const escape = source.indexOf("\x1b[");
        if (escape < 0) { output += source; break; }
        output += source.slice(0, escape);
        source = source.slice(escape);
        let match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(source);
        if (match) {
          onMouse({ button: Number(match[1]), x: Number(match[2]), y: Number(match[3]), press: match[4] === "M" });
          source = source.slice(match[0].length);
          continue;
        }
        match = /^\x1b\[(\d+);(\d+)R/.exec(source);
        if (match) {
          onCursorPosition({ row: Number(match[1]), column: Number(match[2]) });
          source = source.slice(match[0].length);
          continue;
        }
        if (/^\x1b\[(?:<\d*(?:;\d*){0,2}|\d*(?:;\d*)?)?$/.test(source)) {
          pending = source;
          break;
        }
        output += source.slice(0, 2);
        source = source.slice(2);
      }
      if (output) this.push(output);
      done();
    },
  });
  input.isTTY = process.stdin.isTTY;
  input.setRawMode = (mode) => process.stdin.setRawMode?.(mode);
  return input;
}
