# Builds mcp-stockfish from upstream + a tiny Node HTTP→stdio bridge.
# Stockfish binary comes from Debian (Alpine has no stockfish package).

FROM golang:1.23-bookworm AS mcpbuild
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/sonirico/mcp-stockfish.git .
RUN CGO_ENABLED=0 go build -o /out/mcp-stockfish .

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends stockfish ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && STOCKFISH_BIN="$(command -v stockfish || ls /usr/games/stockfish 2>/dev/null)" \
  && ln -sf "$STOCKFISH_BIN" /usr/local/bin/stockfish
COPY --from=mcpbuild /out/mcp-stockfish /usr/local/bin/mcp-stockfish
RUN chmod +x /usr/local/bin/mcp-stockfish

WORKDIR /app
COPY services/stockfish-bridge/package.json ./
COPY services/stockfish-bridge/server.mjs ./
ENV MCP_STOCKFISH_BIN=/usr/local/bin/mcp-stockfish
ENV MCP_STOCKFISH_PATH=/usr/local/bin/stockfish
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
