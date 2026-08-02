/**
 * lib/agent/transpile.ts — TypeScript and JSX for generated apps (#20).
 *
 * The agent may write .ts / .tsx / .jsx; we compile each one to a sibling .js
 * the moment it is written, keeping BOTH in the workspace. That keeps every
 * property the architecture depends on:
 *   - the workspace stays browser-ready, so the live preview needs no build
 *   - `read_app_file` still returns the SOURCE the agent wrote, so it can edit
 *     its own file instead of re-reading compiled output
 *   - deploys stay byte copies (sources are filtered out at publish time)
 *
 * Boundary note: this is `esbuild.transform()` — text in, text out, with no
 * config file, no plugins, no filesystem access and no npm resolution. It is
 * the same call we already make to parse-check every file. The rule XVibe
 * enforces is "no arbitrary third-party code execution", which bundlers and
 * their plugin/config evaluation violate and a pure transform does not.
 */
import { transform } from "esbuild";

/** Source extensions the browser cannot run directly. */
const SOURCE_EXT = /\.(ts|tsx|jsx)$/i;

export const isTranspilable = (path: string): boolean => SOURCE_EXT.test(path) && !/\.d\.ts$/i.test(path);

/** Where the compiled sibling lands: js/app.tsx → js/app.js */
export const compiledPathFor = (path: string): string => path.replace(SOURCE_EXT, ".js");

/** esbuild loader for a source path (also used by the parse-check). */
export function loaderFor(path: string): "ts" | "tsx" | "jsx" | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "ts" ? "ts" : ext === "tsx" ? "tsx" : ext === "jsx" ? "jsx" : undefined;
}

export interface Transpiled {
  path: string;
  code: string;
}

/**
 * Compile one source file. JSX uses the automatic runtime pointed at "preact",
 * so the emitted code imports `preact/jsx-runtime` rather than requiring the
 * author to keep `h` in scope — the app's import map resolves that specifier
 * to the vendored bundle.
 */
export async function transpileAppFile(path: string, source: string): Promise<Transpiled> {
  const loader = loaderFor(path);
  if (!loader) throw new Error(`Not a transpilable source file: ${path}`);

  const res = await transform(source, {
    loader,
    format: "esm",
    target: "es2020",
    ...(loader === "ts"
      ? {}
      : { jsx: "automatic" as const, jsxImportSource: "preact" }),
    sourcefile: path,
  });

  return { path: compiledPathFor(path), code: res.code };
}

/**
 * The import map an app needs before it can load JSX output. Every specifier
 * esbuild might emit resolves to the single vendored file.
 */
export const IMPORT_MAP_SNIPPET = `<script type="importmap">
{"imports":{"preact":"/vendor/preact.js","preact/hooks":"/vendor/preact.js","preact/jsx-runtime":"/vendor/preact.js","preact/jsx-dev-runtime":"/vendor/preact.js"}}
</script>`;
