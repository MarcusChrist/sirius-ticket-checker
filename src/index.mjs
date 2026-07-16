import "dotenv/config";
import * as cheerio from "cheerio";
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const EVENTS_URL =
  process.env.EVENTS_URL || "https://siriusfotboll.ebiljett.nu/List/Events";
const STATE_FILE = process.env.STATE_FILE || "./data/seen-events.json";
const NOTIFY_ON_FIRST_RUN = /^true$/i.test(
  process.env.NOTIFY_ON_FIRST_RUN || "false",
);
const INCLUDE_TEXT = (process.env.INCLUDE_TEXT || "").trim().toLowerCase();
const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(
  /\/$/,
  "",
);
const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || "").trim();
const SOURCE_MODE = (process.env.SOURCE_MODE || "auto").trim().toLowerCase(); // auto, ebiljett, sirius
const SIRIUS_SITE_URL = (
  process.env.SIRIUS_SITE_URL || "https://www.siriusfotboll.se"
).replace(/\/$/, "");
const SEARCH_TERMS = (process.env.SEARCH_TERMS || "biljettsläpp,biljetter,biljett")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
const HEALTH_ALERT_AFTER_FAILURES = Number(
  process.env.HEALTH_ALERT_AFTER_FAILURES || "3",
);

async function main() {
  const { events, sourceStats } = await fetchEvents();
  const filteredEvents = INCLUDE_TEXT
    ? events.filter((event) =>
        `${event.title} ${event.dateText} ${event.rawText}`
          .toLowerCase()
          .includes(INCLUDE_TEXT),
      )
    : events;

  const state = await loadState();
  const healthySources = sourceStats.filter((source) => source.ok).length;
  const failedSources = sourceStats.filter((source) => !source.ok);

  if (healthySources === 0) {
    const consecutiveSourceFailures = (state.consecutiveSourceFailures || 0) + 1;
    console.warn(
      `All sources failed (${failedSources.map((s) => s.name).join(", ") || "none"}). Consecutive failures: ${consecutiveSourceFailures}.`,
    );
    await saveState({
      ...state,
      lastCheckedAt: new Date().toISOString(),
      lastFoundCount: 0,
      consecutiveSourceFailures,
      lastHealthAlertAt: state.lastHealthAlertAt || null,
    });
    await maybeNotifyHealthIssue(
      state,
      consecutiveSourceFailures,
      failedSources,
    );
    return;
  }

  if (filteredEvents.length === 0) {
    console.log(
      "No ticket/news signals found. Exiting without error so Railway does not restart-loop.",
    );
    await saveState({
      ...state,
      lastCheckedAt: new Date().toISOString(),
      lastFoundCount: 0,
      consecutiveSourceFailures: 0,
    });
    return;
  }

  const isFirstRun = !state.baselineEstablished;
  const seen = new Set(state.seenKeys);
  const newEvents = filteredEvents.filter((event) => !seen.has(event.key));

  console.log(
    `Found ${filteredEvents.length} signal(s), ${newEvents.length} new. Sources ok: ${healthySources}/${sourceStats.length}.`,
  );
  for (const source of sourceStats) {
    if (source.ok) {
      console.log(`  ${source.name}: ${source.count} signal(s)`);
    } else {
      console.warn(`  ${source.name}: failed (${source.error})`);
    }
  }

  let notified = false;

  if (newEvents.length > 0 && (!isFirstRun || NOTIFY_ON_FIRST_RUN)) {
    await notify(newEvents);
    notified = true;
  } else if (newEvents.length > 0 && isFirstRun && !NOTIFY_ON_FIRST_RUN) {
    console.log(
      "First run: creating baseline without notifications. Set NOTIFY_ON_FIRST_RUN=true to notify on first run.",
    );
  }

  // Only mark events as seen after a successful notify, or when we intentionally
  // baseline. Never advance state if notify was required but no channel exists.
  if (newEvents.length > 0 && !notified && !isFirstRun) {
    throw new Error(
      "New signals found but notifications were not sent; refusing to mark them as seen.",
    );
  }

  for (const event of filteredEvents) {
    seen.add(event.key);
  }

  await saveState({
    seenKeys: [...seen].sort(),
    lastCheckedAt: new Date().toISOString(),
    lastFoundCount: filteredEvents.length,
    baselineEstablished: true,
    consecutiveSourceFailures: 0,
    lastHealthAlertAt: state.lastHealthAlertAt || null,
  });
}

async function fetchEvents() {
  const sources = [];

  if (SOURCE_MODE === "auto" || SOURCE_MODE === "ebiljett") {
    sources.push(["eBiljett", fetchEbiljettEvents]);
  }

  if (SOURCE_MODE === "auto" || SOURCE_MODE === "sirius") {
    sources.push(["Sirius website", fetchSiriusWebsiteSignals]);
  }

  const byKey = new Map();
  const sourceStats = [];

  for (const [name, fetcher] of sources) {
    try {
      const events = await fetcher();
      console.log(`${name}: found ${events.length} signal(s).`);
      for (const event of events) byKey.set(event.key, event);
      sourceStats.push({ name, ok: true, count: events.length, error: null });
    } catch (error) {
      console.warn(`${name}: skipped because ${error.message}`);
      sourceStats.push({
        name,
        ok: false,
        count: 0,
        error: error.message,
      });
    }
  }

  return {
    events: [...byKey.values()].sort((a, b) =>
      `${a.dateText} ${a.title}`.localeCompare(
        `${b.dateText} ${b.title}`,
        "sv",
      ),
    ),
    sourceStats,
  };
}

async function fetchEbiljettEvents() {
  const response = await fetch(EVENTS_URL, {
    redirect: "follow",
    headers: browserHeaders("https://www.siriusfotboll.se/matchdag/biljetter/"),
  });

  if (!response.ok) {
    throw new Error(
      `ticket page returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const byKey = new Map();

  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    if (!href.includes("/Tickets/Select/")) return;

    const url = new URL(href, EVENTS_URL).toString();
    const key = `ebiljett:${eventKeyFromUrl(url)}`;
    const card = findLikelyEventContainer($, anchor);
    const lines = normalizeLines(card.text());
    const title = extractTitle($, card, lines) || "Sirius-match";
    const dateText = extractDateText(lines);
    const rawText = lines.join(" | ");

    byKey.set(key, { key, title, dateText, url, rawText, source: "eBiljett" });
  });

  return [...byKey.values()];
}

async function fetchSiriusWebsiteSignals() {
  const byKey = new Map();

  // Latest news feed: catches brand-new posts even when the title does not
  // rank well in search (the old relevance search buried 2026 articles).
  const latestUrl = `${SIRIUS_SITE_URL}/wp-json/wp/v2/news?per_page=30&orderby=date&order=desc&_fields=id,date,title,link,excerpt`;
  for (const event of await fetchWordPressNews(latestUrl, "latest")) {
    byKey.set(event.key, event);
  }

  // Date-ordered search for ticket terms across older pages of news.
  for (const term of SEARCH_TERMS) {
    const newsUrl = `${SIRIUS_SITE_URL}/wp-json/wp/v2/news?search=${encodeURIComponent(term)}&per_page=20&orderby=date&order=desc&_fields=id,date,title,link,excerpt`;
    for (const event of await fetchWordPressNews(newsUrl, term)) {
      byKey.set(event.key, event);
    }
  }

  // HTML fallback only if the API produced nothing usable.
  if (byKey.size === 0) {
    const htmlUrls = [
      `${SIRIUS_SITE_URL}/nyheter/`,
      `${SIRIUS_SITE_URL}/?s=${encodeURIComponent("biljettsläpp")}`,
      `${SIRIUS_SITE_URL}/?s=${encodeURIComponent("biljetter")}`,
    ];

    for (const url of htmlUrls) {
      try {
        const htmlSignals = await fetchSiriusHtmlSignals(url);
        for (const event of htmlSignals) byKey.set(event.key, event);
      } catch (error) {
        console.warn(`Sirius HTML ${url}: skipped because ${error.message}`);
      }
    }
  }

  if (byKey.size === 0) {
    throw new Error("Sirius sources returned no usable ticket signals");
  }

  return [...byKey.values()];
}

async function fetchWordPressNews(url, term) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      ...browserHeaders(SIRIUS_SITE_URL),
      accept: "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(
      `WordPress news search for "${term}" returned HTTP ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return [];

  const results = await response.json();
  if (!Array.isArray(results)) return [];

  return results
    .map((item) => {
      const title = clean(
        decodeHtml(
          typeof item.title === "object"
            ? item.title?.rendered
            : item.title || "Sirius biljettinfo",
        ),
      );
      const excerpt = clean(
        decodeHtml(
          typeof item.excerpt === "object"
            ? item.excerpt?.rendered
            : item.excerpt || "",
        ).replace(/<[^>]+>/g, " "),
      );
      const url = item.link || item.url || "";
      const dateText = item.date
        ? String(item.date).slice(0, 10)
        : "Sirius biljett-/nyhetssignal";
      const rawText = `${title} ${excerpt} ${url}`;
      if (!isUsefulSiriusSignal(url, rawText)) return null;

      return {
        key: `sirius:${stableKey(url || `news:${item.id}`)}`,
        title,
        dateText,
        url: url || `${SIRIUS_SITE_URL}/?s=${encodeURIComponent(term)}`,
        rawText,
        source: "Sirius website",
      };
    })
    .filter(Boolean);
}

async function fetchSiriusHtmlSignals(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: browserHeaders(SIRIUS_SITE_URL),
  });

  if (!response.ok) {
    throw new Error(`Sirius HTML page returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const byKey = new Map();

  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, url).toString();
    } catch {
      return;
    }

    // Prefer the link text itself so site chrome ("Biljetter & kort") does not
    // make every news article look like a ticket signal.
    const anchorText = clean($(anchor).text());
    if (!isUsefulSiriusSignal(absoluteUrl, anchorText)) return;

    byKey.set(`sirius:${stableKey(absoluteUrl)}`, {
      key: `sirius:${stableKey(absoluteUrl)}`,
      title: anchorText || "Sirius biljettinfo",
      dateText: "Sirius biljett-/nyhetssignal",
      url: absoluteUrl,
      rawText: anchorText,
      source: "Sirius website",
    });
  });

  return [...byKey.values()];
}

function isUsefulSiriusSignal(url, text) {
  const normalizedUrl = url.toLowerCase().replace(/\/$/, "");
  const normalizedText = text.toLowerCase();

  // Listing roots and static pages are never signals.
  if (
    normalizedUrl.endsWith("/nyheter") ||
    normalizedUrl.endsWith("/event") ||
    normalizedUrl.endsWith("/matchdag/biljetter") ||
    normalizedUrl.endsWith("/matchdag/biljetter/foreningsbiljetter")
  ) {
    return false;
  }

  const isSiriusContent =
    normalizedUrl.includes("siriusfotboll.se/nyheter/") ||
    normalizedUrl.includes("siriusfotboll.se/event/");
  const hasTicketSignal =
    /biljett|biljettsläpp|ebiljett|biljettinfo|säkra.*plats|släpps.*försäljning|ute till försäljning/i.test(
      normalizedText,
    );
  return isSiriusContent && hasTicketSignal;
}

function browserHeaders(referer) {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    "upgrade-insecure-requests": "1",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };
}

function findLikelyEventContainer($, anchor) {
  let best = $(anchor).parent();
  let current = $(anchor).parent();

  for (let i = 0; i < 8 && current.length; i++) {
    const text = normalizeLines(current.text()).join(" ");
    const looksLikeEvent =
      /(kl\.|allsvenskan|svenska cupen|ik sirius|köp biljett|biljett)/i.test(
        text,
      );
    const notEntirePage = text.length < 2000;

    if (looksLikeEvent && notEntirePage) {
      best = current;
    }

    current = current.parent();
  }

  return best;
}

function extractTitle($, card, lines) {
  const heading = card.find("h1,h2,h3,h4").first().text().trim();
  if (heading) return clean(heading);

  const candidate = lines.find(
    (line) =>
      /sirius|biljettsläpp|biljett/i.test(line) &&
      !/reservation|varukorg/i.test(line),
  );
  if (candidate) return clean(candidate);

  return clean(
    lines.find((line) => !/köp biljett|allsvenskan|kl\./i.test(line)) || "",
  );
}

function extractDateText(lines) {
  return clean(
    lines.find((line) =>
      /kl\.|\d{1,2}:\d{2}|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec/i.test(
        line,
      ),
    ) || "Datum saknas",
  );
}

function eventKeyFromUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.at(-1) || parsed.pathname;
}

function stableKey(input) {
  try {
    const parsed = new URL(input);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return input;
  }
}

function normalizeLines(text) {
  return text
    .split("\n")
    .map(clean)
    .filter(Boolean)
    .filter((line, index, arr) => arr.indexOf(line) === index);
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function loadState() {
  try {
    const content = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(content);
    const seenKeys = Array.isArray(parsed.seenKeys) ? parsed.seenKeys : [];
    return {
      seenKeys,
      lastCheckedAt: parsed.lastCheckedAt || null,
      lastFoundCount: parsed.lastFoundCount || 0,
      // Older state files without the flag still count as baselined if they
      // already contain keys from a prior successful run.
      baselineEstablished: Boolean(
        parsed.baselineEstablished || seenKeys.length > 0,
      ),
      consecutiveSourceFailures: parsed.consecutiveSourceFailures || 0,
      lastHealthAlertAt: parsed.lastHealthAlertAt || null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        seenKeys: [],
        lastCheckedAt: null,
        lastFoundCount: 0,
        baselineEstablished: false,
        consecutiveSourceFailures: 0,
        lastHealthAlertAt: null,
      };
    }
    throw error;
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpFile, STATE_FILE);
}

async function maybeNotifyHealthIssue(state, consecutiveSourceFailures, failedSources) {
  if (consecutiveSourceFailures < HEALTH_ALERT_AFTER_FAILURES) return;
  if (!hasNotificationChannel()) return;

  const lastAlert = state.lastHealthAlertAt
    ? Date.parse(state.lastHealthAlertAt)
    : 0;
  const sixHoursMs = 6 * 60 * 60 * 1000;
  if (lastAlert && Date.now() - lastAlert < sixHoursMs) return;

  const details = failedSources
    .map((source) => `${source.name}: ${source.error}`)
    .join("\n");

  await notifyMessage(
    "Sirius ticket watcher: sources failing",
    `No sources succeeded for ${consecutiveSourceFailures} consecutive runs.\n\n${details}\n\nTicket releases may be missed until this is fixed.`,
  );

  const latest = await loadState();
  await saveState({
    ...latest,
    lastHealthAlertAt: new Date().toISOString(),
  });
}

function hasNotificationChannel() {
  return Boolean(NTFY_TOPIC || SLACK_WEBHOOK_URL);
}

async function notify(events) {
  const title =
    events.length === 1
      ? `Ny Sirius-signal: ${events[0].title}`
      : `${events.length} nya Sirius-signaler`;

  const body = events
    .map(
      (event) =>
        `🎫 ${event.title}\n${event.dateText}\n${event.url}\nKälla: ${event.source || "okänd"}`,
    )
    .join("\n\n");

  await notifyMessage(title, body);
}

async function notifyMessage(title, body) {
  const tasks = [];

  if (NTFY_TOPIC) {
    tasks.push(sendNtfy(title, body));
  }

  if (SLACK_WEBHOOK_URL) {
    tasks.push(sendSlack(title, body));
  }

  if (tasks.length === 0) {
    throw new Error(
      "No notification channel configured. Set NTFY_TOPIC or SLACK_WEBHOOK_URL before marking signals as seen.",
    );
  }

  await Promise.all(tasks);
}

async function sendNtfy(title, body) {
  const response = await fetch(
    `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`,
    {
      method: "POST",
      headers: {
        Title: title,
        Priority: "5",
        Tags: "soccer,ticket",
      },
      body,
    },
  );

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}`);
  }
}

async function sendSlack(title, body) {
  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `*${title}*\n${body}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack returned HTTP ${response.status}`);
  }
}

main()
  .then(() => {
    // Cron containers must fully terminate. npm-wrapped starts and open
    // fetch keep-alives can leave the process Active on Railway, which
    // blocks/fails the next scheduled run about 15 minutes later.
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
