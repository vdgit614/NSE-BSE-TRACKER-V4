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
  const value = normalize(exchange);

  return value === "BSE"
    ? "BSE"
    : "NSE";
}

function yahooSymbol(symbol, exchange = "NSE") {
  const cleanSymbol =
    normalize(symbol)
      .replace(/\.NS$/i, "")
      .replace(/\.BO$/i, "");

  const exc = normalizeExchange(exchange);

  // INDEX SYMBOLS
  if (cleanSymbol.toUpperCase() === "NIFTY") {
    return "^NSEI";
  }

  if (cleanSymbol.toUpperCase() === "SENSEX") {
    return "^BSESN";
  }

  // STOCK SYMBOLS
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

  if (p === "3m") {
    return {
      range: "3mo",
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
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
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

async function searchYahoo(query) {
  const searchUrl =
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=20&newsCount=0`;

  const response =
    await fetch(
      searchUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
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

function buildMarketFromChart(chart) {
  const meta =
    chart.meta || {};

  const closes =
    chart.indicators
      ?.quote?.[0]
      ?.close || [];

  const price =
    Number(
      meta.regularMarketPrice
    );

  let previousClose =
    Number(
      meta.previousClose
    );

  if (
    !Number.isFinite(previousClose) ||
    previousClose <= 0
  ) {
    const validCloses =
      closes.filter(
        value =>
          value !== null &&
          value !== undefined &&
          Number.isFinite(
            Number(value)
          )
      );

    if (
      validCloses.length >= 2
    ) {
      previousClose =
        Number(
          validCloses[
            validCloses.length - 2
          ]
        );
    }
  }

  let finalPrice =
    Number.isFinite(price)
      ? price
      : null;

  if (
    finalPrice === null &&
    closes.length > 0
  ) {
    const validCloses =
      closes.filter(
        value =>
          value !== null &&
          value !== undefined &&
          Number.isFinite(
            Number(value)
          )
      );

    if (validCloses.length > 0) {
      finalPrice =
        Number(
          validCloses[
            validCloses.length - 1
          ]
        );
    }
  }

  const change =
    finalPrice !== null &&
    Number.isFinite(previousClose)
      ? finalPrice - previousClose
      : null;

  const changePercent =
    change !== null &&
    Number.isFinite(previousClose) &&
    previousClose !== 0
      ? (
          change /
          previousClose
        ) * 100
      : null;

  return {
    price:
      finalPrice,

    previous_close:
      Number.isFinite(previousClose)
        ? previousClose
        : null,

    change,

    change_percent:
      changePercent,

    currency:
      meta.currency ||
      "INR",

    market_state:
      meta.marketState ||
      null,

    fifty_two_week_high:
      meta.fiftyTwoWeekHigh ??
      null,

    fifty_two_week_low:
      meta.fiftyTwoWeekLow ??
      null
  };
}

// --------------------------------------------------
// AI NEWS HELPERS
// --------------------------------------------------

function buildNewsPrompt(
  symbol,
  exchange,
  companyName
) {

  return `
Search the web for the latest news about the Indian listed company:

Company: ${companyName}
Stock Symbol: ${symbol}
Exchange: ${exchange}

IMPORTANT:
- Search only news published during the LAST 15 DAYS from today.
- Use current web search results.
- Do not use old news unless it was published within the last 15 days.
- Focus specifically on this company and its stock/business.
- Include important company announcements, business developments,
  contracts/orders, financial developments, management news,
  regulatory news, major partnerships, acquisitions, technology news,
  and other developments that may be relevant to investors.
- Prefer reliable original sources and established financial/business news sources.
- Do not invent or guess any news.
- Do not include unrelated news about similarly named companies.

Return the result as JSON only.

For every news item return:
{
  "title": "Very short Hindi headline",
  "summary": "One very short Hindi sentence explaining the news",
  "sentiment": "positive" | "negative" | "neutral",
  "source": "Original source/publication name",
  "url": "Original article URL",
  "published_at": "Publication date"
}

Rules:
- Maximum 10 important news items.
- Sort newest first.
- Headlines and summaries must be short.
- Use Hindi for title and summary.
- Keep the original source name.
- Give the direct original article URL whenever available.
- Do not provide investment advice.
- Do not say buy, sell or hold.
- Do not fabricate URLs.
`;
}

// --------------------------------------------------
// OPENAI / CHATGPT NEWS
// --------------------------------------------------

async function getOpenAINews(prompt, env) {

  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      status: "error",
      message: "OPENAI_API_KEY is not configured"
    };
  }

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },

      body: JSON.stringify({

        model: "gpt-5.6",

        tools: [
          {
            type: "web_search"
          }
        ],

        input: prompt
      })
    }
  );

  if (!response.ok) {

    const errorText =
      await response.text();

    return {
      status: "error",
      message:
        "OpenAI API error",
      details:
        errorText
    };
  }

  const data =
    await response.json();

  let outputText = "";

  if (data.output_text) {

    outputText =
      data.output_text;

  } else if (Array.isArray(data.output)) {

    for (const item of data.output) {

      if (
        item.type === "message" &&
        Array.isArray(item.content)
      ) {

        for (
          const content
          of item.content
        ) {

          if (
            content.type === "output_text"
          ) {

            outputText +=
              content.text || "";
          }
        }
      }
    }
  }

  return {
    status: "ok",
    provider: "chatgpt",
    text: outputText
  };
}


// --------------------------------------------------
// GEMINI NEWS
// --------------------------------------------------

async function getGeminiNews(prompt, env) {

  const apiKey =
    env.GEMINI_API_KEY;

  if (!apiKey) {

    return {
      status: "error",
      message:
        "GEMINI_API_KEY is not configured"
    };
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-goog-api-key":
          apiKey
      },

      body: JSON.stringify({

        model:
  "gemini-3.1-flash-lite",

        input:
          prompt,

        tools: [
          {
            type:
              "google_search"
          }
        ]
      })
    }
  );

  if (!response.ok) {

    const errorText =
      await response.text();

    return {
      status: "error",
      message:
        "Gemini API error",
      details:
        errorText
    };
  }

  const data =
    await response.json();

  let outputText = "";

  if (data.output_text) {

    outputText =
      data.output_text;

  } else if (
    data.outputs &&
    Array.isArray(data.outputs)
  ) {

    for (
      const item
      of data.outputs
    ) {

      if (
        item.type ===
        "text"
      ) {

        outputText +=
          item.text || "";
      }
    }
  }

  return {
    status: "ok",
    provider: "gemini",
    text: outputText
  };
}
export default {
  async fetch(request, env) {

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
              status:
                "error",

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
              status:
                "error",

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
                  .replace(
                    /\s+/g,
                    "_"
                  )
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

          status:
            "ok",

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

          status:
            "ok",

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
      // NSE -> D1
      // BSE -> Yahoo
      // --------------------------------------------------

      if (path === "/search") {

        const rawQuery =
          url.searchParams.get("q") ||
          "";

        const query =
          normalize(
            rawQuery
          );

        const exchange =
          normalizeExchange(
            url.searchParams.get(
              "exchange"
            )
          );

        if (!query) {

          return jsonResponse({

            status:
              "ok",

            exchange,

            query:
              "",

            count:
              0,

            results:
              []

          });
        }

        // NSE SEARCH

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

            status:
              "ok",

            exchange:
              "NSE",

            query,

            count:
              result.results?.length ||
              0,

            results:
              result.results ||
              []

          });
        }

        // BSE SEARCH

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
                  exchangeName === "BSE"
                );
              }
            )
            .slice(
              0,
              20
            )
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

          status:
            "ok",

          exchange:
            "BSE",

          query,

          count:
            results.length,

          results

        });
      }

      // --------------------------------------------------
// HISTORY
// --------------------------------------------------
if (path === "/history") {

const symbol =
  normalize(
    url.searchParams.get("symbol")
  );

const exchange =
  normalizeExchange(
    url.searchParams.get("exchange")
  );

const period =
  String(
    url.searchParams.get("period") || "7d"
  ).toLowerCase();

if (!symbol) {

  return jsonResponse(
    {
      status: "error",
      message: "Stock symbol is required"
    },
    400
  );
}

const allowedPeriods = [
  "7d",
  "1m",
  "3m",
  "6m",
  "1y"
];

const selectedPeriod =
  allowedPeriods.includes(period)
    ? period
    : "7d";

const rangeInfo =
  periodToRange(selectedPeriod);

const chart =
  await fetchYahooChart(
    symbol,
    exchange,
    rangeInfo.range,
    rangeInfo.interval
  );

const timestamps =
  chart.timestamp || [];

const closes =
  chart.indicators
    ?.quote?.[0]
    ?.close || [];

const history = [];

for (
  let i = 0;
  i < timestamps.length;
  i++
) {

  const timestamp =
    timestamps[i];

  const close =
    closes[i];

  if (
    timestamp === null ||
    timestamp === undefined ||
    close === null ||
    close === undefined
  ) {
    continue;
  }

  const numericClose =
    Number(close);

  if (
    !Number.isFinite(numericClose)
  ) {
    continue;
  }

  history.push({
    timestamp:
      Number(timestamp),

    date:
      new Date(
        Number(timestamp) * 1000
      ).toISOString(),

    close:
      numericClose
  });
}

return jsonResponse({
  status: "ok",

  symbol,

  exchange,

  period:
    selectedPeriod,

  count:
    history.length,

  history
});

}

      // --------------------------------------------------
// EXTRACT AI NEWS JSON
// --------------------------------------------------

function extractNewsJson(text) {

  if (!text) {
    return [];
  }

  let clean =
    String(text)
      .trim();

  // Remove markdown code fences
  clean =
    clean
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  // Try direct JSON first
  try {

    const direct =
      JSON.parse(clean);

    if (
      Array.isArray(direct)
    ) {
      return direct;
    }

    if (
      Array.isArray(
        direct.news
      )
    ) {
      return direct.news;
    }

  } catch (error) {
    // Continue with extraction
  }

  // Find JSON object
  const firstBrace =
    clean.indexOf("{");

  const lastBrace =
    clean.lastIndexOf("}");

  if (
    firstBrace >= 0 &&
    lastBrace > firstBrace
  ) {

    try {

      const jsonText =
        clean.substring(
          firstBrace,
          lastBrace + 1
        );

      const parsed =
        JSON.parse(jsonText);

      if (
        Array.isArray(
          parsed.news
        )
      ) {
        return parsed.news;
      }

    } catch (error) {
      // Invalid JSON
    }
  }

  // Find JSON array
  const firstBracket =
    clean.indexOf("[");

  const lastBracket =
    clean.lastIndexOf("]");

  if (
    firstBracket >= 0 &&
    lastBracket > firstBracket
  ) {

    try {

      const jsonText =
        clean.substring(
          firstBracket,
          lastBracket + 1
        );

      const parsed =
        JSON.parse(jsonText);

      if (
        Array.isArray(parsed)
      ) {
        return parsed;
      }

    } catch (error) {
      // Invalid JSON
    }
  }

  return [];
}
// --------------------------------------------------
// AI NEWS
// --------------------------------------------------

if (path === "/news") {

  const symbol =
    normalize(
      url.searchParams.get("symbol")
    );

  const exchange =
    normalizeExchange(
      url.searchParams.get("exchange")
    );

  const provider =
    String(
      url.searchParams.get("provider") ||
      "chatgpt"
    ).toLowerCase();

  if (!symbol) {

    return jsonResponse(
      {
        status: "error",
        message: "Stock symbol is required"
      },
      400
    );
  }

  if (
    provider !== "chatgpt" &&
    provider !== "gemini"
  ) {

    return jsonResponse(
      {
        status: "error",
        message:
          "Provider must be chatgpt or gemini"
      },
      400
    );
  }

  // --------------------------------------------------
  // FIND COMPANY NAME
  // --------------------------------------------------

  let companyName = "";

  // NSE -> D1
  if (exchange === "NSE") {

    const stock =
      await env.DB.prepare(`
        SELECT
          symbol,
          company_name
        FROM instruments
        WHERE exchange = 'NSE'
          AND search_symbol = ?
        LIMIT 1
      `)
        .bind(symbol)
        .first();

    if (stock) {

      companyName =
        String(
          stock.company_name || ""
        ).trim();
    }
  }

  // BSE -> Yahoo search
  if (
    exchange === "BSE" &&
    !companyName
  ) {

    try {

      const quotes =
        await searchYahoo(
          symbol
        );

      const match =
        quotes.find(
          quote => {

            const yahooSymbol =
              String(
                quote.symbol || ""
              ).toUpperCase();

            return (
              yahooSymbol ===
              `${symbol}.BO`
            );
          }
        );

      if (match) {

        companyName =
          String(
            match.longname ||
            match.shortname ||
            ""
          ).trim();
      }

    } catch (error) {

      companyName = "";
    }
  }

  if (!companyName) {

    companyName =
      symbol;
  }

  // --------------------------------------------------
  // BUILD READY-MADE PROMPT
  // --------------------------------------------------

  const prompt =
    buildNewsPrompt(
      symbol,
      exchange,
      companyName
    );

  // --------------------------------------------------
  // CALL SELECTED AI
  // --------------------------------------------------

  let aiResult;

  if (provider === "chatgpt") {

    aiResult =
      await getOpenAINews(
        prompt,
        env
      );

  } else {

    aiResult =
      await getGeminiNews(
        prompt,
        env
      );
  }

  if (
    !aiResult ||
    aiResult.status !== "ok"
  ) {

    return jsonResponse(
      {
        status: "error",

        provider,

        symbol,

        exchange,

        company_name:
          companyName,

        message:
          aiResult?.message ||
          "News search failed",

        details:
          aiResult?.details || ""
      },
      502
    );
  }

  // --------------------------------------------------
  // PARSE AI JSON
  // --------------------------------------------------

  if (
  url.searchParams.get("debug") === "1"
) {
  return jsonResponse({
    status: "debug",
    provider,
    symbol,
    exchange,
    company_name: companyName,
    ai_text: aiResult.text || ""
  });
  }
  let news =
  extractNewsJson(
    aiResult.text || ""
  );

  // --------------------------------------------------
  // CLEAN NEWS ITEMS
  // --------------------------------------------------

  news =
    news
      .map(
        item => {

          const sentiment =
            String(
              item.sentiment ||
              "neutral"
            ).toLowerCase();

          let cleanSentiment =
            "neutral";

          if (
            sentiment === "positive"
          ) {

            cleanSentiment =
              "positive";

          } else if (
            sentiment === "negative"
          ) {

            cleanSentiment =
              "negative";
          }

          return {

            title:
              String(
                item.title || ""
              ).trim(),

            summary:
              String(
                item.summary || ""
              ).trim(),

            sentiment:
              cleanSentiment,

            source:
              String(
                item.source || ""
              ).trim(),

            url:
              String(
                item.url || ""
              ).trim(),

            published_at:
              String(
                item.published_at || ""
              ).trim()
          };
        }
      )
      .filter(
        item =>
          item.title &&
          item.url
      )
      .slice(
        0,
        10
      );

  // --------------------------------------------------
  // FINAL RESPONSE
  // --------------------------------------------------

  return jsonResponse({

    status: "ok",

    provider,

    symbol,

    exchange,

    company_name:
      companyName,

    period:
      "last_15_days",

    count:
      news.length,

    news
  });
}
      // --------------------------------------------------
      // STOCK DETAILS
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

        // --------------------------------------------------
        // INDEX SYMBOLS
        // --------------------------------------------------

        const isIndex =
          symbol === "NIFTY" ||
          symbol === "SENSEX";

        if (isIndex) {

          stock = {

            exchange,

            symbol,

            company_name:
              symbol === "NIFTY"
                ? "NIFTY 50"
                : "SENSEX",

            security_id: "",

            isin: "",

            sector: "",

            trading_status: "ACTIVE"

          };

        }

        // --------------------------------------------------
        // NSE STOCK
        // --------------------------------------------------

        else if (
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

        // --------------------------------------------------
        // BSE STOCK
        // --------------------------------------------------

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

          // BSE

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
              stock.company_name === symbol
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

        // NSE

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

        // BSE

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

        let previousClose =
          null;

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

          const close =
            Number(
              closes[i]
            );

          if (
            !Number.isFinite(close)
          ) {
            continue;
          }

          let change = null;
          let changePercent = null;

          if (
            previousClose !== null &&
            Number.isFinite(
              previousClose
            ) &&
            previousClose !== 0
          ) {

            change =
              close -
              previousClose;

            changePercent =
              (
                change /
                previousClose
              ) * 100;
          }

          history.push({

            timestamp:
              timestamps[i],

            date:
              new Date(
                timestamps[i] * 1000
              ).toISOString(),

            open:
              opens[i] !== null &&
              opens[i] !== undefined
                ? Number(opens[i])
                : null,

            high:
              highs[i] !== null &&
              highs[i] !== undefined
                ? Number(highs[i])
                : null,

            low:
              lows[i] !== null &&
              lows[i] !== undefined
                ? Number(lows[i])
                : null,

            close,

            change,

            change_percent:
              changePercent,

            volume:
              volumes[i] !== null &&
              volumes[i] !== undefined
                ? Number(volumes[i])
                : null
          });

          previousClose =
            close;
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
      // News is now handled from the frontend through
      // ChatGPT Search and Google Search.
      // This route is retained so the old endpoint
      // does not break unexpectedly.
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
                "Symbol is required"
            },
            400
          );
        }

        let companyName =
          symbol;

        if (
          exchange === "NSE"
        ) {

          const instrument =
            await env.DB.prepare(`
              SELECT company_name
              FROM instruments
              WHERE exchange = 'NSE'
                AND symbol = ?
              LIMIT 1
            `)
              .bind(symbol)
              .first();

          if (
            instrument?.company_name
          ) {
            companyName =
              instrument.company_name;
          }
        }

        return jsonResponse({

          status:
            "ok",

          exchange,

          symbol,

          company_name:
            companyName,

          period:
            "last_15_days",

          news:
            [],

          message:
            "News search is available through ChatGPT Search and Google Search buttons in the app."

        });
      }

      // --------------------------------------------------
      // OLD NEWS TEST ROUTE
      // --------------------------------------------------

      if (
        path === "/news-test"
      ) {

        return jsonResponse({

          status:
            "ok",

          message:
            "News API test route retained. The app now uses ChatGPT Search and Google Search for news."

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
