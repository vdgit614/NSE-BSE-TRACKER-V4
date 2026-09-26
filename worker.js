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
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    }
  );
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

function normalizeExchange(exchange) {

  const value =
    normalize(exchange);

  return value === "BSE"
    ? "BSE"
    : "NSE";

}

function yahooSymbol(
  symbol,
  exchange = "NSE"
) {

  const cleanSymbol =
    normalize(symbol)
      .replace(/\.NS$/i, "")
      .replace(/\.BO$/i, "");

  const exc =
    normalizeExchange(exchange);

  return `${cleanSymbol}.${exc === "BSE" ? "BO" : "NS"}`;

}

function periodToRange(period) {

  const p =
    String(period || "1y")
      .toLowerCase();

  if (p === "7d") {

    return {
      range: "5d",
      interval: "1d"
    };

  }

  if (p === "1m") {

    return {
      range: "1mo",
      interval: "1d"
    };

  }

  if (p === "6m") {

    return {
      range: "6mo",
      interval: "1d"
    };

  }

  return {
    range: "1y",
    interval: "1d"
  };

}

async function fetchYahooChart(
  symbol,
  exchange = "NSE",
  range = "1y",
  interval = "1d"
) {

  const ticker =
    yahooSymbol(
      symbol,
      exchange
    );

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${encodeURIComponent(range)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&events=history`;

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0",
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `Market data request failed: HTTP ${response.status}`
    );

  }

  const data =
    await response.json();

  if (
    !data ||
    !data.chart ||
    !data.chart.result ||
    !data.chart.result[0]
  ) {

    throw new Error(
      "Market data not available"
    );

  }

  return data.chart.result[0];

}

async function searchYahoo(
  query
) {

  const searchUrl =
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=20&newsCount=0`;

  const response =
    await fetch(
      searchUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0",
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `Yahoo search failed: HTTP ${response.status}`
    );

  }

  const data =
    await response.json();

  return data.quotes || [];

}

function buildMarketFromChart(
  chart
) {

  const meta =
    chart.meta || {};

  const price =
    Number(meta.regularMarketPrice) ||
    Number(meta.previousClose) ||
    null;

  const previousClose =
    Number(meta.previousClose) ||
    null;

  const change =
    price !== null &&
    previousClose !== null
      ? price - previousClose
      : null;

  const changePercent =
    price !== null &&
    previousClose !== null &&
    previousClose !== 0
      ? (change / previousClose) * 100
      : null;

  return {

    price,

    previous_close:
      previousClose,

    change,

    change_percent:
      changePercent,

    currency:
      meta.currency || "INR",

    market_state:
      meta.marketState || null,

    fifty_two_week_high:
      meta.fiftyTwoWeekHigh ??
      null,

    fifty_two_week_low:
      meta.fiftyTwoWeekLow ??
      null

  };

}
export default {

  async fetch(
    request,
    env
  ) {

    try {

      if (
        request.method ===
        "OPTIONS"
      ) {

        return jsonResponse({
          status: "ok"
        });

      }

      const url =
        new URL(request.url);

      const path =
        url.pathname;

      await ensureSchema(env);

      // --------------------------------------------------
      // ROOT
      // --------------------------------------------------

      if (path === "/") {

        return jsonResponse({

          status: "ok",

          project:
            "NSE-BSE-TRACKER-V4",

          database:
            "connected",

          exchanges: [
            "NSE",
            "BSE"
          ]

        });

      }

      // --------------------------------------------------
      // NSE INSTRUMENT MASTER IMPORT
      // --------------------------------------------------

      if (path === "/import-nse") {

        const nseUrl =
          "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

        const response =
          await fetch(
            nseUrl,
            {
              headers: {

                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

                "Accept":
                  "text/csv,text/plain,application/csv,application/octet-stream,*/*",

                "Referer":
                  "https://www.nseindia.com/"

              }
            }
          );

        if (!response.ok) {

          return jsonResponse(
            {
              status: "error",

              message:
                "NSE instrument file download failed",

              http_status:
                response.status

            },
            502
          );

        }

        const csvText =
          await response.text();

        const lines =
          csvText
            .split(/\r?\n/)
            .map(
              line =>
                line.trim()
            )
            .filter(Boolean);

        if (lines.length < 2) {

          return jsonResponse(
            {
              status: "error",

              message:
                "NSE CSV file is empty or invalid"

            },
            500
          );

        }

        const headers =
          parseCSVLine(lines[0])
            .map(
              h =>
                normalize(h)
                  .replace(/\s+/g, "_")
            );

        const headerIndex = {};

        headers.forEach(
          (header, index) => {

            headerIndex[header] =
              index;

          }
        );

        function getColumn(
          row,
          names
        ) {

          for (
            const name of names
          ) {

            if (
              headerIndex[name] !==
              undefined
            ) {

              return (
                row[
                  headerIndex[name]
                ] || ""
              );

            }

          }

          return "";

        }

        const records = [];

        for (
          let i = 1;
          i < lines.length;
          i++
        ) {

          const row =
            parseCSVLine(
              lines[i]
            );

          const symbol =
            normalize(
              getColumn(
                row,
                [
                  "SYMBOL",
                  "SYMBOL_NAME"
                ]
              )
            );

          const companyName =
            String(
              getColumn(
                row,
                [
                  "NAME_OF_COMPANY",
                  "COMPANY_NAME",
                  "NAME"
                ]
              )
            ).trim();

          const series =
            normalize(
              getColumn(
                row,
                ["SERIES"]
              )
            );

          const securityId =
            normalize(
              getColumn(
                row,
                [
                  "SECURITY_ID",
                  "SECURITY_ID_CODE"
                ]
              )
            );

          const isin =
            normalize(
              getColumn(
                row,
                [
                  "ISIN_NO",
                  "ISIN"
                ]
              )
            );

          const tradingStatus =
            String(
              getColumn(
                row,
                [
                  "STATUS",
                  "TRADING_STATUS"
                ]
              )
            ).trim();

          if (!symbol) {
            continue;
          }

          if (
            series &&
            series !== "EQ"
          ) {
            continue;
          }

          records.push({

            exchange:
              "NSE",

            symbol,

            company_name:
              companyName,

            security_id:
              securityId,

            isin,

            sector:
              "",

            trading_status:
              tradingStatus,

            search_symbol:
              symbol,

            search_name:
              normalize(
                companyName
              )

          });

        }

        await env.DB.prepare(
          `DELETE FROM instruments
           WHERE exchange = 'NSE'`
        ).run();

        const batchSize =
          50;

        let imported =
          0;

        for (
          let i = 0;
          i < records.length;
          i += batchSize
        ) {

          const batch =
            records.slice(
              i,
              i + batchSize
            );

          const statements =
            batch.map(
              record =>
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

          await env.DB.batch(
            statements
          );

          imported +=
            batch.length;

        }

        return jsonResponse({

          status: "ok",

          message:
            "NSE instrument master imported successfully",

          exchange:
            "NSE",

          imported

        });

      }

      // --------------------------------------------------
      // NSE COUNT
      // --------------------------------------------------

      if (path === "/nse-count") {

        const result =
          await env.DB.prepare(`
            SELECT COUNT(*) AS count
            FROM instruments
            WHERE exchange = 'NSE'
          `).first();

        return jsonResponse({

          status: "ok",

          exchange:
            "NSE",

          count:
            Number(
              result?.count || 0
            )

        });

      }

      // --------------------------------------------------
      // SEARCH
      //
      // NSE -> D1
      // BSE -> Yahoo search
      // --------------------------------------------------

      if (path === "/search") {

        const rawQuery =
          url.searchParams.get("q") ||
          "";

        const query =
          normalize(rawQuery);

        const exchange =
          normalizeExchange(
            url.searchParams.get(
              "exchange"
            )
          );

        if (!query) {

          return jsonResponse({

            status: "ok",

            exchange,

            query: "",

            count: 0,

            results: []

          });

        }

        // -------------------------
        // NSE SEARCH
        // -------------------------

        if (
          exchange === "NSE"
        ) {

          const exactSymbol =
            query;

          const symbolPrefix =
            `${query}%`;

          const nameSearch =
            `%${query}%`;

          const result =
            await env.DB.prepare(`
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

          return jsonResponse({

            status: "ok",

            exchange:
              "NSE",

            query,

            count:
              result.results?.length ||
              0,

            results:
              result.results || []

          });

        }

        // -------------------------
        // BSE SEARCH
        // -------------------------

        const quotes =
          await searchYahoo(
            query
          );

        const results =
          quotes
            .filter(
              quote => {

                const symbol =
                  String(
                    quote.symbol ||
                    ""
                  ).toUpperCase();

                const exchangeName =
                  String(
                    quote.exchange ||
                    ""
                  ).toUpperCase();

                return (
                  symbol.endsWith(".BO") ||
                  exchangeName ===
                    "BSE"
                );

              }
            )
            .slice(0, 20)
            .map(
              quote => {

                const yahooTicker =
                  String(
                    quote.symbol ||
                    ""
                  ).toUpperCase();

                const cleanSymbol =
                  yahooTicker
                    .replace(
                      /\.BO$/i,
                      ""
                    );

                return {

                  exchange:
                    "BSE",

                  symbol:
                    cleanSymbol,

                  company_name:
                    quote.longname ||
                    quote.shortname ||
                    cleanSymbol,

                  security_id:
                    /^\d+$/.test(
                      cleanSymbol
                    )
                      ? cleanSymbol
                      : "",

                  isin:
                    "",

                  sector:
                    "",

                  trading_status:
                    "",

                  yahoo_symbol:
                    yahooTicker

                };

              }
            );

        return jsonResponse({

          status: "ok",

          exchange:
            "BSE",

          query,

          count:
            results.length,

          results

        });

          }
            // --------------------------------------------------
      // STOCK DETAILS
      // /stock?exchange=NSE&symbol=TCS
      // /stock?exchange=BSE&symbol=TCS
      // --------------------------------------------------

      if (path === "/stock") {

        const symbol =
          normalize(
            url.searchParams.get(
              "symbol"
            )
          );

        const exchange =
          normalizeExchange(
            url.searchParams.get(
              "exchange"
            )
          );

        if (!symbol) {

          return jsonResponse(
            {
              status:
                "error",

              message:
                "Stock symbol is required"

            },
            400
          );

        }

        let stock = null;

        // -------------------------
        // NSE
        // -------------------------

        if (
          exchange === "NSE"
        ) {

          stock =
            await env.DB.prepare(`
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
                AND search_symbol = ?
              LIMIT 1
            `)
              .bind(symbol)
              .first();

          if (!stock) {

            return jsonResponse(
              {

                status:
                  "error",

                message:
                  "NSE stock not found",

                symbol

              },
              404
            );

          }

        }

        // -------------------------
        // BSE
        // -------------------------

        else {

          stock = {

            exchange:
              "BSE",

            symbol,

            company_name:
              symbol,

            security_id:
              /^\d+$/.test(symbol)
                ? symbol
                : "",

            isin:
              "",

            sector:
              "",

            trading_status:
              ""

          };

        }

        let market = null;

        try {

          const chart =
            await fetchYahooChart(
              symbol,
              exchange,
              "5d",
              "1d"
            );

          const meta =
            chart.meta || {};

          if (
            exchange === "BSE" &&
            (
              !stock.company_name ||
              stock.company_name ===
                symbol
            )
          ) {

            stock.company_name =
              meta.longName ||
              meta.shortName ||
              symbol;

          }

          market =
            buildMarketFromChart(
              chart
            );

        } catch (
          marketError
        ) {

          market = {

            price:
              null,

            previous_close:
              null,

            change:
              null,

            change_percent:
              null,

            currency:
              "INR",

            market_state:
              null,

            data_error:
              marketError.message

          };

        }

        return jsonResponse({

          status:
            "ok",

          exchange,

          symbol,

          stock,

          market

        });

      }

      // --------------------------------------------------
      // HISTORICAL DATA
      // --------------------------------------------------

      if (path === "/history") {

        const symbol =
          normalize(
            url.searchParams.get(
              "symbol"
            )
          );

        const exchange =
          normalizeExchange(
            url.searchParams.get(
              "exchange"
            )
          );

        const period =
          String(
            url.searchParams.get(
              "period"
            ) || "1y"
          ).toLowerCase();

        if (!symbol) {

          return jsonResponse(
            {

              status:
                "error",

              message:
                "Stock symbol is required"

            },
            400
          );

        }

        let stock = null;

        // -------------------------
        // NSE
        // -------------------------

        if (
          exchange === "NSE"
        ) {

          stock =
            await env.DB.prepare(`
              SELECT
                symbol,
                company_name,
                sector,
                isin
              FROM instruments
              WHERE exchange = 'NSE'
                AND search_symbol = ?
              LIMIT 1
            `)
              .bind(symbol)
              .first();

          if (!stock) {

            return jsonResponse(
              {

                status:
                  "error",

                message:
                  "NSE stock not found",

                symbol

              },
              404
            );

          }

        }

        // -------------------------
        // BSE
        // -------------------------

        else {

          stock = {

            symbol,

            company_name:
              symbol,

            sector:
              "",

            isin:
              ""

          };

        }

        const settings =
          periodToRange(
            period
          );

        const chart =
          await fetchYahooChart(
            symbol,
            exchange,
            settings.range,
            settings.interval
          );

        const timestamps =
          chart.timestamp || [];

        const quote =
          chart.indicators
            ?.quote?.[0] || {};

        const opens =
          quote.open || [];

        const highs =
          quote.high || [];

        const lows =
          quote.low || [];

        const closes =
          quote.close || [];

        const volumes =
          quote.volume || [];

        const history = [];

        for (
          let i = 0;
          i < timestamps.length;
          i++
        ) {

          if (
            closes[i] === null ||
            closes[i] === undefined
          ) {
            continue;
          }

          history.push({

            timestamp:
              timestamps[i],

            open:
              opens[i],

            high:
              highs[i],

            low:
              lows[i],

            close:
              closes[i],

            volume:
              volumes[i]

          });

        }

        return jsonResponse({

          status:
            "ok",

          exchange,

          symbol,

          company_name:
            stock.company_name,

          period,

          currency:
            chart.meta?.currency ||
            "INR",

          history

        });

      }

      // --------------------------------------------------
      // NEWS
      // --------------------------------------------------

      if (path === "/news") {

        const symbol =
          normalize(
            url.searchParams.get(
              "symbol"
            )
          );

        const exchange =
          normalizeExchange(
            url.searchParams.get(
              "exchange"
            )
          );

        if (!symbol) {

          return jsonResponse(
            {

              status:
                "error",

              message:
                "Stock symbol is required"

            },
            400
          );

        }

        let companyName =
          symbol;

        if (
          exchange === "NSE"
        ) {

          const stock =
            await env.DB.prepare(`
              SELECT company_name
              FROM instruments
              WHERE exchange = 'NSE'
                AND search_symbol = ?
              LIMIT 1
            `)
              .bind(symbol)
              .first();

          if (!stock) {

            return jsonResponse(
              {

                status:
                  "error",

                message:
                  "NSE stock not found",

                symbol

              },
              404
            );

          }

          companyName =
            stock.company_name ||
            symbol;

        }

        const searchText =
          `${symbol} ${companyName}`;

        const newsUrl =
          `https://news.google.com/rss/search?q=${encodeURIComponent(searchText)}&hl=en-IN&gl=IN&ceid=IN:en`;

        const response =
          await fetch(
            newsUrl,
            {
              headers: {

                "User-Agent":
                  "Mozilla/5.0",

                "Accept":
                  "application/rss+xml,application/xml,text/xml,*/*"

              }
            }
          );

        if (!response.ok) {

          return jsonResponse({

            status:
              "ok",

            exchange,

            symbol,

            news: [],

            message:
              "News source unavailable"

          });

        }

        const xml =
          await response.text();

        const items = [];

        const itemMatches =
          xml.match(
            /<item>[\s\S]*?<\/item>/g
          ) || [];

        for (
          const item
          of itemMatches.slice(0, 10)
        ) {

          const titleMatch =
            item.match(
              /<title><!\[CDATA\[(.*?)\]\]><\/title>/
            );

          const linkMatch =
            item.match(
              /<link>(.*?)<\/link>/
            );

          const dateMatch =
            item.match(
              /<pubDate>(.*?)<\/pubDate>/
            );

          const title =
            titleMatch
              ? titleMatch[1]
              : "";

          const link =
            linkMatch
              ? linkMatch[1]
              : "";

          const published =
            dateMatch
              ? dateMatch[1]
              : "";

          if (title) {

            items.push({

              title,

              link,

              published

            });

          }

        }

        return jsonResponse({

          status:
            "ok",

          exchange,

          symbol,

          company_name:
            companyName,

          news:
            items

        });

      }

      // --------------------------------------------------
      // UNKNOWN ROUTE
      // --------------------------------------------------

      return jsonResponse(

        {

          status:
            "error",

          message:
            "Route not found",

          path

        },

        404

      );

    } catch (error) {

      return jsonResponse(

        {

          status:
            "error",

          message:
            error?.message ||
            String(error)

        },

        500

      );

    }

  }

};
