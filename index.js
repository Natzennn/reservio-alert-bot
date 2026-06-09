const { chromium } = require("playwright");
const TelegramBot = require("node-telegram-bot-api");

const RESERVIO_URL = process.env.RESERVIO_URL || "https://test1874.reservio.com/events";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const WEEKS_AHEAD = Number(process.env.WEEKS_AHEAD || 8);

// true = przy starcie wyśle aktualnie znalezione terminy
const NOTIFY_ON_START = process.env.NOTIFY_ON_START !== "false";

// true = pomija terminy z tekstem "Pełne obłożenie"
const ONLY_AVAILABLE = process.env.ONLY_AVAILABLE !== "false";

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Brakuje TELEGRAM_BOT_TOKEN w zmiennych środowiskowych.");
}

if (!TELEGRAM_CHAT_ID) {
  throw new Error("Brakuje TELEGRAM_CHAT_ID w zmiennych środowiskowych.");
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let knownEvents = new Set();
let firstRun = true;
let browser;
let isChecking = false;

async function sendTelegram(message) {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "HTML",
      disable_web_page_preview: false
    });

    console.log("Wysłano wiadomość Telegram.");
  } catch (err) {
    console.error("Błąd wysyłki Telegram:", err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getEventKey(event) {
  return `${event.week}::${event.title}::${event.url}`;
}

async function scrapeCurrentPageEvents(page) {
  const pageUrl = page.url();

  const data = await page.evaluate((onlyAvailable) => {
    function clean(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    const bodyText = clean(document.body.innerText || "");

    const weekMatch = bodyText.match(
      /[a-ząćęłńóśźż]+ \d{1,2}, \d{4} - [a-ząćęłńóśźż]+ \d{1,2}, \d{4}/i
    );

    const week = weekMatch ? weekMatch[0] : "";

    const elements = Array.from(
      document.querySelectorAll("a, button, article, [role='button'], div, li")
    );

    const results = [];

    for (const el of elements) {
      const text = clean(el.innerText || el.textContent || "");
      if (!text) continue;

      const lower = text.toLowerCase();

      const hasTime = /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(text);

      const looksLikeTraining =
        lower.includes("trening") ||
        lower.includes("piro") ||
        lower.includes("idpa") ||
        lower.includes("pistolet") ||
        lower.includes("strzeleck");

      if (!hasTime || !looksLikeTraining) continue;

      // Pomijamy duże kontenery tygodnia, które zawierają kilka wydarzeń naraz
      if (text.length > 260) continue;

      const isFull =
        lower.includes("pełne obłożenie") ||
        lower.includes("pelne oblozenie") ||
        lower.includes("fully booked") ||
        lower.includes("brak miejsc");

      if (onlyAvailable && isFull) continue;

      let href = "";

      if (el.href) {
        href = el.href;
      } else {
        const link = el.querySelector("a[href]");
        href = link ? link.href : window.location.href;
      }

      results.push({
        week,
        title: text,
        url: href,
        isFull
      });
    }

    const unique = new Map();

    for (const item of results) {
      unique.set(`${item.week}::${item.title}::${item.url}`, item);
    }

    return Array.from(unique.values());
  }, ONLY_AVAILABLE);

  return data.map((event) => ({
    week: normalizeText(event.week),
    title: normalizeText(event.title),
    url: event.url || pageUrl,
    isFull: Boolean(event.isFull)
  }));
}

async function goToNextWeek(page) {
  const nextHref = await page
    .locator('a[aria-label="Przyszły tydzień"], a[aria-label*="Przyszły"], a[href*="week="]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  if (nextHref) {
    const absoluteUrl = new URL(nextHref, page.url()).toString();

    console.log(`Przechodzę do przyszłego tygodnia: ${absoluteUrl}`);

    await page.goto(absoluteUrl, {
      waitUntil: "networkidle",
      timeout: 45000
    });

    await page.waitForTimeout(2000);
    return true;
  }

  console.log("Nie znaleziono linku Przyszły tydzień.");
  return false;
}

async function scrapeReservioEvents(page) {
  await page.goto(RESERVIO_URL, {
    waitUntil: "networkidle",
    timeout: 45000
  });

  await page.waitForTimeout(3000);

  const allEvents = [];

  for (let weekIndex = 0; weekIndex <= WEEKS_AHEAD; weekIndex++) {
    console.log(`Skanuję tydzień ${weekIndex + 1}/${WEEKS_AHEAD + 1}: ${page.url()}`);

    const events = await scrapeCurrentPageEvents(page);

    console.log(`W tym tygodniu znaleziono terminów: ${events.length}`);

    events.forEach((event, index) => {
      console.log(`${index + 1}. [${event.week}] ${event.title}`);
      console.log(event.url);
    });

    allEvents.push(...events);

    if (weekIndex === WEEKS_AHEAD) break;

    const moved = await goToNextWeek(page);

    if (!moved) {
      break;
    }

    await sleep(700);
  }

  const unique = new Map();

  for (const event of allEvents) {
    unique.set(getEventKey(event), event);
  }

  return Array.from(unique.values());
}

async function notifyCurrentEventsAtStart(events) {
  await sendTelegram(
    `🤖 <b>Bot Reservio wystartował</b>\n\n` +
      `Strona: ${escapeHtml(RESERVIO_URL)}\n` +
      `Sprawdzam tygodni do przodu: <b>${WEEKS_AHEAD}</b>\n` +
      `Tylko dostępne: <b>${ONLY_AVAILABLE ? "tak" : "nie"}</b>\n` +
      `Znalezione terminy: <b>${events.length}</b>`
  );

  if (events.length === 0) {
    await sendTelegram(
      `Brak aktualnie dostępnych terminów.\n\n` +
        `Jeżeli chcesz widzieć też pełne terminy, ustaw w Railway:\n` +
        `<code>ONLY_AVAILABLE=false</code>`
    );
    return;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    await sendTelegram(
      `📌 <b>Termin dostępny teraz</b> (${i + 1}/${events.length})\n\n` +
        `<b>${escapeHtml(event.week)}</b>\n\n` +
        `${escapeHtml(event.title)}\n\n` +
        `🔗 ${escapeHtml(event.url)}`
    );

    await sleep(400);
  }
}

async function checkEvents() {
  if (isChecking) {
    console.log("Poprzednie sprawdzanie jeszcze trwa — pomijam ten cykl.");
    return;
  }

  isChecking = true;

  let page;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true
      });
    }

    page = await browser.newPage({
      viewport: {
        width: 1366,
        height: 900
      }
    });

    console.log(`[${new Date().toISOString()}] Sprawdzam: ${RESERVIO_URL}`);

    const events = await scrapeReservioEvents(page);

    console.log(`Znaleziono łącznie terminów: ${events.length}`);

    if (firstRun) {
      for (const event of events) {
        knownEvents.add(getEventKey(event));
      }

      if (NOTIFY_ON_START) {
        await notifyCurrentEventsAtStart(events);
      } else {
        await sendTelegram("✅ Bot wystartował i działa poprawnie.");
      }

      firstRun = false;
      return;
    }

    const newEvents = [];

    for (const event of events) {
      const key = getEventKey(event);

      if (!knownEvents.has(key)) {
        knownEvents.add(key);
        newEvents.push(event);
      }
    }

    for (const event of newEvents) {
      await sendTelegram(
        `🚨 <b>Nowy dostępny termin w Reservio</b>\n\n` +
          `<b>${escapeHtml(event.week)}</b>\n\n` +
          `${escapeHtml(event.title)}\n\n` +
          `🔗 ${escapeHtml(event.url)}`
      );

      await sleep(400);
    }

    if (newEvents.length > 0) {
      console.log(`Wysłano powiadomienia: ${newEvents.length}`);
    } else {
      console.log("Brak nowych terminów.");
    }
  } catch (err) {
    console.error("Błąd podczas sprawdzania:", err.message);

    try {
      await sendTelegram(`⚠️ Bot napotkał błąd:\n<code>${escapeHtml(err.message)}</code>`);
    } catch (_) {}
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }

    isChecking = false;
  }
}

async function main() {
  console.log("Reservio Alert Bot startuje...");
  console.log(`WEEKS_AHEAD=${WEEKS_AHEAD}`);
  console.log(`CHECK_INTERVAL_MS=${CHECK_INTERVAL_MS}`);
  console.log(`RESERVIO_URL=${RESERVIO_URL}`);
  console.log(`NOTIFY_ON_START=${NOTIFY_ON_START}`);
  console.log(`ONLY_AVAILABLE=${ONLY_AVAILABLE}`);

  await checkEvents();

  setInterval(async () => {
    await checkEvents();
  }, CHECK_INTERVAL_MS);
}

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

main();
