import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stockfish.js WASM is loaded via createRequire on the server
  serverExternalPackages: ["stockfish"],
  // The repo sits inside a larger monorepo-ish folder; pin tracing to this app
  outputFileTracingRoot: path.join(process.cwd()),
  // Engine JS + WASM must ship with the serverless functions
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/stockfish/bin/**",
      "./node_modules/stockfish/index.js",
      "./node_modules/stockfish/package.json",
    ],
    "/mcp": [
      "./node_modules/stockfish/bin/**",
      "./node_modules/stockfish/index.js",
      "./node_modules/stockfish/package.json",
    ],
  },
};

export default nextConfig;
