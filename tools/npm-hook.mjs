// Node loader hooks so the SSDA edge function can be tested locally with plain
// `node tools/test-ssda.mjs`:
//
//   - `npm:pkg@version[/sub]` specifiers (Deno-style) resolve against the
//     local node_modules install.
//   - `.wasm` asset imports become modules exporting the bytes as a Uint8Array
//     (mirrors Deno's `with { type: "bytes" }` behavior).
//
// Registered from tools/test-ssda.mjs via `module.register`.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function stripNpm(spec) {
  let s = spec.slice("npm:".length);
  const m = s.match(/^(@[^/]+\/[^/@]+|[^/@]+)@[^/]*(\/.*)?$/);
  if (m) s = m[1] + (m[2] ?? "");
  return s;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("npm:")) {
    return nextResolve(stripNpm(specifier), context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".wasm")) {
    const bytes = await readFile(fileURLToPath(url));
    return {
      format: "module",
      shortCircuit: true,
      source: `export default new Uint8Array(${JSON.stringify([...bytes])});`,
    };
  }
  return nextLoad(url, context);
}
