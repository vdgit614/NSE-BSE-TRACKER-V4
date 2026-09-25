function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

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
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*"
    }
  });
}

async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS instruments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      company_name TEXT,
      security_id TEXT,
      isin TEXT,
      sector TEXT,
      trading_status TEXT,
      search_symbol TEXT,
      search_name TEXT,
      UNIQUE(exchange, symbol)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_instruments_symbol
    ON instruments(search_symbol)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_instruments_name
    ON instruments(search_name)
  `).run();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Make sure D1 table and indexes exist
      await ensureSchema(env);

      // --------------------------------------------------
      // ROOT / CONNECTION TEST
      // --------------------------------------------------
      if (path === "/") {
        return jsonResponse({
          status: "ok",
          project: "NSE-BSE-TRACKER-V4",
          database: "connected"
        });
      }

      // --------------------------------------------------
      // NSE INSTRUMENT MASTER IMPORT
      // --------------------------------------------------
      if (path === "/import-nse") {
        const nseUrl =
          "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

        const response = await fetch(nseUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept":
              "text/csv,text/plain,application/csv,application/octet-stream,*/*",
            "Referer": "https://www.nseindia.com/"
          }
        });

        if (!response.ok) {
          return jsonResponse(
            {
              status: "error",
              message: "NSE instrument file download failed",
              http_status: response.status
            },
            502
          );
        }

        const csvText = await response.text();

        const lines = csvText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        if (lines.length < 2) {
          return jsonResponse(
            {
              status: "error",
              message: "NSE CSV file is empty or invalid"
            },
            500
          );
        }

        const headers = parseCSVLine(lines[0]).map((h) =>
          normalize(h).replace(/\s+/g, "_")
        );

        const headerIndex = {};

        headers.forEach((header, index) => {
          headerIndex[header] = index;
        });

        function getColumn(row, names) {
          for (const name of names) {
            if (headerIndex[name] !== undefined) {
              return row[headerIndex[name]] || "";
            }
          }
          return "";
        }

        const records = [];

        for (let i = 1; i < lines.length; i++) {
          const row = parseCSVLine(lines[i]);

          const symbol = normalize(
            getColumn(row, ["SYMBOL", "SYMBOL_NAME"])
          );

          const companyName = String(
            getColumn(row, [
              "NAME_OF_COMPANY",
              "COMPANY_NAME",
              "NAME"
            ])
          ).trim();

          const series = normalize(
            getColumn(row, ["SERIES"])
          );

          const securityId = normalize(
            getColumn(row, [
              "SECURITY_ID",
              "SECURITY_ID_CODE"
            ])
          );

          const isin = normalize(
            getColumn(row, ["ISIN_NO", "ISIN"])
          );

          const tradingStatus = String(
            getColumn(row, [
              "STATUS",
              "TRADING_STATUS"
            ])
          ).trim();

          if (!symbol) {
            continue;
          }

          // Only NSE Equity series
          if (series && series !== "EQ") {
            continue;
          }

          records.push({
            exchange: "NSE",
            symbol,
            company_name: companyName,
            security_id: securityId,
            isin,
            sector: "",
            trading_status: tradingStatus,
            search_symbol: symbol,
            search_name: normalize(companyName)
          });
        }

        // Remove previous NSE master
        await env.DB.prepare(
          `DELETE FROM instruments WHERE exchange = 'NSE'`
        ).run();

        // Insert in batches
        const batchSize = 50;
        let imported = 0;

        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);

          const statements = batch.map((record) =>
            env.DB.prepare(`
              INSERT INTO instruments (
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
                security_id = excluded.security_id,
                isin = excluded.isin,
                trading_status = excluded.trading_status,
                search_symbol = excluded.search_symbol,
                search_name = excluded.search_name
            `).bind(
              record.exchange,
              record.symbol,
              record.company_name,
              record.security_id,
              record.isin,
              record.sector,
              record.trading_status,
              record.search_symbol,
              record.search_name
            )
          );

          await env.DB.batch(statements);

          imported += batch.length;
        }

        return jsonResponse({
          status: "ok",
          message: "NSE instrument master imported successfully",
          exchange: "NSE",
          imported
        });
      }

      // --------------------------------------------------
      // NSE COUNT
      // --------------------------------------------------
      if (path === "/nse-count") {
        const result = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM instruments
          WHERE exchange = 'NSE'
        `).first();

        return jsonResponse({
          status: "ok",
          exchange: "NSE",
          count: Number(result?.count || 0)
        });
      }

      // --------------------------------------------------
      // NSE SEARCH API
      // Example:
      // /search?q=reliance
      // /search?q=RELI
      // /search?q=infosys
      // --------------------------------------------------
      if (path === "/search") {
        const rawQuery = url.searchParams.get("q") || "";
        const query = normalize(rawQuery);

        if (!query) {
          return jsonResponse({
            status: "ok",
            exchange: "NSE",
            query: "",
            count: 0,
            results: []
          });
        }

        const exactSymbol = query;
        const symbolPrefix = `${query}%`;
        const nameSearch = `%${query}%`;

        const result = await env.DB.prepare(`
          SELECT
            id,
            exchange,
            symbol,
            company_name,
            security_id,
            isin,
            sector,
            trading_status
          FROM instruments
          WHERE exchange = 'NSE'
            AND (
              search_symbol = ?
              OR search_symbol LIKE ?
              OR search_name LIKE ?
            )
          ORDER BY
            CASE
              WHEN search_symbol = ? THEN 0
              WHEN search_symbol LIKE ? THEN 1
              WHEN search_name LIKE ? THEN 2
              ELSE 3
            END,
            search_symbol ASC
          LIMIT 20
        `)
          .bind(
            exactSymbol,
            symbolPrefix,
            nameSearch,
            exactSymbol,
            symbolPrefix,
            nameSearch
          )
          .all();

        const results = result.results || [];

        return jsonResponse({
          status: "ok",
          exchange: "NSE",
          query,
          count: results.length,
          results
        });
      }

      // --------------------------------------------------
      // UNKNOWN ROUTE
      // --------------------------------------------------
      return jsonResponse(
        {
          status: "error",
          message: "Route not found",
          path
        },
        404
      );
    } catch (error) {
      return jsonResponse(
        {
          status: "error",
          message: error?.message || String(error)
        },
        500
      );
    }
  }
};
