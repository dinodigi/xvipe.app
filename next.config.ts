import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // XVibe is a client of Pluggie over HTTP/MCP only (CONNECTION.md §6).
  // The boundary is enforced mechanically by scripts/check-boundary.mjs.

  // esbuild (the verification layer's parser) ships a native binary — it must
  // load from node_modules at runtime, never be bundled by Turbopack.
  serverExternalPackages: ["esbuild"],
};

export default nextConfig;
