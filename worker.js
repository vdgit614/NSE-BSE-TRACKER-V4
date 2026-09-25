export default {
  async fetch(request, env) {
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS instruments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exchange TEXT NOT NULL,
          symbol TEXT NOT NULL,
          company_name TEXT NOT NULL,
          security_id TEXT,
          isin TEXT,
          sector TEXT,
          trading_status TEXT DEFAULT 'ACTIVE',
          search_symbol TEXT NOT NULL,
          search_name TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(exchange, symbol)
        )
      `).run();

      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_instruments_symbol
        ON instruments(exchange, search_symbol)
      `).run();

      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_instruments_name
        ON instruments(exchange, search_name)
      `).run();

      return new Response(
        JSON.stringify({
          status: "ok",
          project: "NSE-BSE-TRACKER-V4",
          database: "connected",
          message: "Instrument Master structure created successfully"
        }),
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: error.message
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
  }
};
