// Standing opponent: one engine tool and the three skill-routing pools.
permit(
  principal is Dome::Agent,
  action == Dome::Action::"mcp:discover",
  resource
);

permit(
  principal is Dome::Agent,
  action == Dome::Action::"mcp:call",
  resource == Dome::MCPTool::"stockfish/chess_engine"
);

forbid(
  principal is Dome::Agent,
  action == Dome::Action::"mcp:call",
  resource
) unless {
  resource == Dome::MCPTool::"stockfish/chess_engine"
};

permit(
  principal is Dome::Agent,
  action == Dome::Action::"llm:invoke",
  resource is Dome::LLMModel
) when {
  resource has pool &&
  resource.pool in [
    "pool/chess-fast",
    "pool/chess-balanced",
    "pool/chess-strong"
  ]
};

forbid(
  principal is Dome::Agent,
  action == Dome::Action::"llm:invoke",
  resource
) unless {
  resource has pool &&
  resource.pool in [
    "pool/chess-fast",
    "pool/chess-balanced",
    "pool/chess-strong"
  ]
};
