export default {
  async fetch(request, env) {
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS test (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL
        )
      `).run();

      await env.DB.prepare(
        "INSERT INTO test (message) VALUES (?)"
      ).bind("V4 D1 test successful").run();

      const result = await env.DB.prepare(
        "SELECT * FROM test ORDER BY id DESC LIMIT 1"
      ).first();

      return new Response(
        JSON.stringify({
          status: "ok",
          project: "NSE-BSE-TRACKER-V4",
          database: "connected",
          test: result
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
