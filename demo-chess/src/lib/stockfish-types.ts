export type StockfishCommandResult = {
  status: "success" | "error";
  session_id?: string;
  command: string;
  response?: string[];
  error?: string;
};
