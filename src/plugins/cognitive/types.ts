// ─── Session configuration (consumed by SessionManager) ───

export type SessionConfig = {
  defaultMode:        string   // mode for first-connect, cron routing, crash fallback. Defaults to 'chatbot'.
  historyWindowHours: number   // trim HistoryStore records older than this on every append.
}
