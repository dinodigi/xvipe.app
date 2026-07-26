import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // XVibe is a client of Pluggie over HTTP/MCP only (CONNECTION.md §6).
  // The boundary is enforced mechanically by scripts/check-boundary.mjs.
};

export default nextConfig;
