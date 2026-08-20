/**
 * Thin HTTP → stdio bridge for sonirico/mcp-stockfish.
 *
 * Upstream HTTP mode is currently a stub (returns immediately). This bridge
 * spawns `mcp-stockfish` on stdio and exposes a minimal MCP HTTP endpoint so
 * we can run the same tool locally (docker compose) or deploy it remotely.
 *
 * Env:
 *   PORT                  listen port (default 8080)
 *   MCP_STOCKFISH_BIN     path/command (default mcp-stockfish)
 *   MCP_STOCKFISH_PATH    passed through to the child (Stockfish binary)
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PORT = Number(process.env.PORT || process.env.MCP_STOCKFISH_HTTP_PORT || 8080);
const BIN = process.env.MCP_STOCKFISH_BIN || "mcp-stockfish";

class StdioMcpClient {
  child;
  pending = new Map();
  nextId = 1;
  ready;

  constructor() {
    this.child = spawn(BIN, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MCP_STOCKFISH_SERVER_MODE: "stdio",
      },
    });

    this.child.on("error", (err) => {
      for (const p of this.pending.values()) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.child.stderr.on("data", (buf) => {
      process.stderr.write(buf);
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id == null) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message || "MCP error"));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        // ignore non-JSON
      }
    });

    this.ready = this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "demo-chess-bridge", version: "0.1.0" },
    }).then(() => {
      this.notify("notifications/initialized", {});
    });
  }

  send(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async request(method, params) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return result;
  }

  async callTool(name, args) {
    await this.ready;
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

let client = null;

function getClient() {
  if (!client) client = new StdioMcpClient();
  return client;
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, bin: BIN }));
    return;
  }

  if (req.method !== "POST" || (req.url !== "/mcp" && req.url !== "/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }

  try {
    const c = getClient();
    if (body.method === "tools/call") {
      const name = body.params?.name || "chess_engine";
      const args = body.params?.arguments || {};
      const result = await c.callTool(name, args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? 1,
        error: { message: `unsupported method: ${body.method}` },
      }),
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? 1,
        error: {
          message: err instanceof Error ? err.message : "bridge error",
        },
      }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mcp-stockfish bridge on :${PORT} (bin=${BIN})`);
});

process.on("SIGINT", async () => {
  await client?.close();
  process.exit(0);
});
