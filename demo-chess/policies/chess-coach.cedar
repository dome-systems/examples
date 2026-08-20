// Delegated coach: one discovered engine tool and the coach model pool.
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
  resource.pool == "pool/coach"
};

forbid(
  principal is Dome::Agent,
  action == Dome::Action::"llm:invoke",
  resource
) unless {
  resource has pool && resource.pool == "pool/coach"
};
