#!/usr/bin/env node
/**
 * build-vendor.mjs — pre-build the runtime libraries we ship INTO generated apps.
 *
 *   npm run vendor
 *
 * Generated apps are static bundles with no build step and no CDN (a broken
 * CDN is a broken app), so any library they use has to travel with them as a
 * plain browser-ready file. This script bundles Preact — core, hooks, and both
 * JSX runtimes — into one self-contained ES module, committed to the repo at
 * lib/vendor/. The studio copies that byte-for-byte into an app's workspace
 * when the agent asks for it.
 *
 * Run once per Preact upgrade, not per build. Bundling happens HERE, on our own
 * dependency, at development time — never on tenant code at request time.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lib", "vendor");
const ENTRY = join(OUT_DIR, ".entry.mjs");

mkdirSync(OUT_DIR, { recursive: true });

// One module re-exporting everything an app needs: `h`/`Fragment` for the
// classic JSX transform, `jsx`/`jsxs` for the automatic one, `render` to mount,
// and the hooks. An import map in the app points every specifier here.
writeFileSync(
  ENTRY,
  `export { h, Fragment, render, createContext, cloneElement, createRef, Component, toChildArray } from "preact";
export { jsx, jsxs, jsxDEV, Fragment as JsxFragment } from "preact/jsx-runtime";
export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useId, useErrorBoundary } from "preact/hooks";
`,
);

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "inline", // keep Preact's MIT notice in the shipped file
  target: ["es2020"],
  write: false,
});

rmSync(ENTRY, { force: true });

const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "preact", "package.json"), "utf8")).version;
const banner = `/* Preact ${version} + hooks + jsx-runtime, bundled for XVibe apps.\n   Vendored on purpose: generated apps are self-contained and never load a CDN.\n   Regenerate with \`npm run vendor\` — do not edit by hand. */\n`;
const code = banner + result.outputFiles[0].text;

const outFile = join(OUT_DIR, "preact.js");
writeFileSync(outFile, code, "utf8");
console.log(`wrote lib/vendor/preact.js — preact ${version}, ${(Buffer.byteLength(code) / 1024).toFixed(1)} kB`);
