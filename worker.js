function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Make sure Instrument Master table exists
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

      // Home / status
      if (path === "/") {
        return new Response(
          JSON.stringify({
            status: "ok",
            project: "NSE-BSE-TRACKER-V4",
            database: "connected",
            message: "Instrument Master ready"
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      // Import NSE Instrument Master
      if (path === "/import-nse") {
        const nseUrl =
          "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

        const response = await fetch(nseUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/csv,*/*"
          }
        });

        if (!response.ok) {
          throw new Error(
            `NSE CSV download failed: HTTP ${response.status}`
          );
        }

        const csvText = await response.text();

        const lines = csvText
          .replace(/^\uFEFF/, "")
          .split(/\r?\n/)
          .filter(line => line.trim() !== "");

        if (lines.length < 2) {
          throw new Error("NSE CSV is empty or invalid");
        }

        const headers = parseCSVLine(lines[0]).map(h =>
          normalize(h)
        );

        const symbolIndex = headers.indexOf("SYMBOL");
        const companyIndex = headers.indexOf("NAME OF COMPANY");
        const seriesIndex = headers.indexOf("SERIES");
        const isinIndex = headers.indexOf("ISIN NUMBER");

        if (
          symbolIndex === -1 ||
          companyIndex === -1 ||
          isinIndex === -1
        ) {
          throw new Error(
            "Required NSE CSV columns were not found"
          );
        }

        const records = [];

        for (let i = 1; i < lines.length; i++) {
          const row = parseCSVLine(lines[i]);

          const symbol = normalize(row[symbolIndex]);
          const companyName = String(
            row[companyIndex] || ""
          ).trim();

          const series = seriesIndex >= 0
            ? normalize(row[seriesIndex])
            : "";

          const isin = String(
            row[isinIndex] || ""
          ).trim();

          // Import normal equity securities.
          // EQ is the main equity series.
          if (
            !symbol ||
            !companyName ||
            !isin ||
            (series && series !== "EQ")
          ) {
            continue;
          }

          records.push({
            symbol,
            companyName,
            isin
          });
        }

        if (records.length === 0) {
          throw new Error("No NSE equity records found");
        }

        // Remove old NSE master before fresh import
        await env.DB.prepare(`
          DELETE FROM instruments
          WHERE exchange = 'NSE'
        `).run();

        let imported = 0;

        // Insert in small batches
        for (let i = 0; i < records.length; i += 50) {
          const batch = records.slice(i, i + 50);

          const statements = batch.map(item =>
            env.DB.prepare(`
              INSERT INTO instruments
              (
                exchange,
                symbol,
                company_name,
                security_id,
                isin,
                sector,
                trading_status,
                search_symbol,
                search_name
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(exchange, symbol)
              DO UPDATE SET
                company_name = excluded.company_name,
                isin = excluded.isin,
                trading_status = excluded.trading_status,
                search_symbol = excluded.search_symbol,
                search_name = excluded.search_name,
                updated_at = CURRENT_TIMESTAMP
            `).bind(
              "NSE",
              item.symbol,
              item.companyName,
              item.symbol,
              item.isin,
              null,
              "ACTIVE",
              item.symbol,
              normalize(item.companyName)
            )
          );

          await env.DB.batch(statements);
          imported += batch.length;
        }

        return new Response(
          JSON.stringify({
            status: "ok",
            project: "NSE-BSE-TRACKER-V4",
            exchange: "NSE",
            imported,
            message: "NSE Instrument Master imported successfully"
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      // Check NSE count
      if (path === "/nse-count") {
        const result = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM instruments
          WHERE exchange = 'NSE'
        `).first();

        return new Response(
          JSON.stringify({
            status: "ok",
            exchange: "NSE",
            count: result.count
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      return new Response(
        JSON.stringify({
          status: "error",
          message: "Endpoint not found"
        }),
        {
          status: 404,
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
