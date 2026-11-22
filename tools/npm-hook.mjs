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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function stripNpm(spec) {
  let s = spec.slice("npm:".length);
  const m = s.match(/^(@[^/]+\/[^/@]+|[^/@]+)@[^/]*(\/.*)?$/);
  if (m) s = m[1] + (m[2] ?? "");
  return s;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("npm:")) {
    const s = stripNpm(specifier);
    // File subpaths (e.g. wasm/ogg.wasm) must bypass the package's "exports"
    // map (wasm-media-encoders' mangles them): map straight to node_modules.
    const m = s.match(/^((?:@[^/]+\/)?[^/]+)\/(.+\.[A-Za-z0-9]+)$/);
    if (m) {
      return nextResolve(new URL(`../node_modules/${m[1]}/${m[2]}`, import.meta.url).href, context);
    }
    return nextResolve(s, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".wasm")) {
    // tests can simulate a runtime that cannot import this wasm (marker file)
    if (url.includes("ogg.wasm") && existsSync(join(tmpdir(), "ssda-fail-ogg-wasm"))) {
      throw new Error("wasm import disabled by test");
    }
    const bytes = await readFile(fileURLToPath(url));
    return {
      format: "module",
      shortCircuit: true,
      source: `export default new Uint8Array(${JSON.stringify([...bytes])});`,
    };
  }
  return nextLoad(url, context);
}
