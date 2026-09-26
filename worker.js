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

  const timestamps =
    chart.timestamp || [];

  const quote =
    chart.indicators
      ?.quote?.[0] || {};

  const closes =
    quote.close || [];

  // ------------------------------------
  // Current price
  // ------------------------------------

  const price =
    Number(meta.regularMarketPrice);

  // ------------------------------------
  // Previous trading-day close
  // ------------------------------------

  let previousClose =
    Number(meta.previousClose);

  // If Yahoo meta.previousClose is missing,
  // use the previous valid historical close.
  if (
    !Number.isFinite(previousClose) &&
    closes.length >= 2
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

  // ------------------------------------
  // Fallback current price
  // ------------------------------------

  const finalPrice =
    Number.isFinite(price)
      ? price
      : (
          closes.length > 0
            ? Number(
                closes[
                  closes.length - 1
                ]
              )
            : null
        );

  // ------------------------------------
  // Change
  // ------------------------------------

  const change =
    finalPrice !== null &&
    Number.isFinite(previousClose)
      ? finalPrice - previousClose
      : null;

  // ------------------------------------
  // Change %
  // ------------------------------------

  const changePercent =
    change !== null &&
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
  try {
    const symbol = normalize(url.searchParams.get("symbol"));
    const exchange = normalizeExchange(url.searchParams.get("exchange"));

    if (!symbol) {
      return jsonResponse(
        {
          status: "error",
          message: "Symbol is required"
        },
        400
      );
    }

    // Get company name from D1
    const instrument = await env.DB.prepare(`
      SELECT symbol, company_name
      FROM instruments
      WHERE exchange = ? AND symbol = ?
      LIMIT 1
    `)
      .bind(exchange, symbol)
      .first();

    if (!instrument) {
      return jsonResponse(
        {
          status: "error",
          message: "Stock not found"
        },
        404
      );
    }

    const companyName = String(instrument.company_name || "").trim();

    // Moneycontrol Hindi RSS feeds
    const rssFeeds = [
      {
        name: "Moneycontrol Hindi",
        url: "https://hindi.moneycontrol.com/news/rss/feeds/latest-news.xml"
      },
      {
        name: "Moneycontrol Hindi",
        url: "https://hindi.moneycontrol.com/news/rss/feeds/markets.xml"
      },
      {
        name: "Moneycontrol Hindi",
        url: "https://hindi.moneycontrol.com/news/rss/feeds/india.xml"
      },
      {
        name: "Moneycontrol Hindi",
        url: "https://hindi.moneycontrol.com/news/rss/feeds/your-money.xml"
      }
    ];

    // XML entity decoder
    function decodeXml(value) {
      return String(value || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, n) =>
          String.fromCharCode(Number(n))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
          String.fromCharCode(parseInt(n, 16))
        )
        .trim();
    }

    function getTag(item, tagName) {
      const regex = new RegExp(
        `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
        "i"
      );

      const match = item.match(regex);
      return match ? decodeXml(match[1]) : "";
    }

    function parseRSS(xmlText) {
      const items = [];
      const itemMatches = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) || [];

      for (const item of itemMatches) {
        const title = getTag(item, "title");
        const link = getTag(item, "link");
        const pubDate =
          getTag(item, "pubDate") ||
          getTag(item, "dc:date");

        const description =
          getTag(item, "description") ||
          getTag(item, "content:encoded");

        if (!title || !link) {
          continue;
        }

        items.push({
          title,
          link,
          pubDate,
          description
        });
      }

      return items;
    }

    // Fetch all RSS feeds together
    const feedResults = await Promise.allSettled(
      rssFeeds.map(async (feed) => {
        const response = await fetch(feed.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 NSE-BSE-TRACKER-V4",
            "Accept": "application/rss+xml, application/xml, text/xml, */*"
          }
        });

        if (!response.ok) {
          throw new Error(
            `RSS request failed: HTTP ${response.status}`
          );
        }

        const xml = await response.text();

        return {
          source: feed.name,
          items: parseRSS(xml)
        };
      })
    );

    // Last 15 days
    const now = Date.now();
    const fifteenDaysAgo =
      now - 15 * 24 * 60 * 60 * 1000;

    // Search terms
    const stockSymbol = symbol.toUpperCase();
    const company = companyName.toUpperCase();

    // Create useful company-name words
    const companyWords = company
      .replace(/[^A-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(word => word.length >= 4)
      .filter(word =>
        ![
          "LIMITED",
          "LTD",
          "INDIA",
          "PRIVATE",
          "PVT",
          "COMPANY",
          "CORPORATION",
          "CORP"
        ].includes(word)
      );

    const allNews = [];

    for (const result of feedResults) {
      if (result.status !== "fulfilled") {
        continue;
      }

      const source = result.value.source;

      for (const item of result.value.items) {
        const publishedTime = Date.parse(item.pubDate);

        // Ignore articles where date cannot be understood
        if (!Number.isFinite(publishedTime)) {
          continue;
        }

        // Only last 15 days
        if (publishedTime < fifteenDaysAgo || publishedTime > now) {
          continue;
        }

        const searchText = (
          item.title +
          " " +
          item.description
        ).toUpperCase();

        let isRelevant = false;

        // Exact stock symbol
        const symbolRegex = new RegExp(
          `(^|[^A-Z0-9])${stockSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`,
          "i"
        );

        if (symbolRegex.test(searchText)) {
          isRelevant = true;
        }

        // Full company name
        if (
          !isRelevant &&
          company.length >= 5 &&
          searchText.includes(company)
        ) {
          isRelevant = true;
        }

        // Important words from company name
        if (!isRelevant && companyWords.length > 0) {
          const matchingWords = companyWords.filter(word =>
            searchText.includes(word)
          );

          if (matchingWords.length >= 2) {
            isRelevant = true;
          }
        }

        if (!isRelevant) {
          continue;
        }

        allNews.push({
          title: item.title,
          source,
          published_at: new Date(publishedTime).toISOString(),
          link: item.link
        });
      }
    }

    // Remove duplicate headlines
    const uniqueNews = [];
    const seen = new Set();

    for (const item of allNews) {
      const key = item.title
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      uniqueNews.push(item);
    }

    // Latest first
    uniqueNews.sort(
      (a, b) =>
        new Date(b.published_at) -
        new Date(a.published_at)
    );

    // Maximum 20 news items
    const news = uniqueNews.slice(0, 20);

    return jsonResponse({
      status: "ok",
      exchange,
      symbol,
      company_name: companyName,
      period: "last_15_days",
      news,
      count: news.length
    });

  } catch (error) {
    return jsonResponse(
      {
        status: "error",
        message: error.message || "News request failed"
      },
      500
    );
  }
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
