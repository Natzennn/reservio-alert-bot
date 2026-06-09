const { chromium } = require("playwright");
const TelegramBot = require("node-telegram-bot-api");

const RESERVIO_URL = process.env.RESERVIO_URL || "https://test1874.reservio.com/events";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const NOTIFY_ON_START = process.env.NOTIFY_ON_START === "true";

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

async function sendTelegram(message) {
  await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

function normalizeText(text) {
  return text
    .replace(/\s+/g, " ")
    .trim();
}

async function scrapeReservioEvents(page) {
  await page.goto(RESERVIO_URL, {
    waitUntil: "networkidle",
    timeout: 45000
  });

  await page.waitForTimeout(3000);

  const events = await page.evaluate(() => {
    function clean(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    const results = [];

    const linkCandidates = Array.from(
      document.querySelectorAll('a[href*="/events/"], a[href*="/event/"], a[href*="/booking"]')
    );

    for (const el of linkCandidates) {
      const text = clean(el.innerText || el.textContent);
      const href = el.href;

      if (!text || text.length < 5) continue;
      if (href.endsWith("/events")) continue;

      results.push({
        title: text,
        url: href
      });
    }

    const possibleCards = Array.from(
      document.querySelectorAll(
        '[data-testid*="event"], [class*="event"], [class*="Event"], article, button'
      )
    );

    for (const el of possibleCards) {
      const text = clean(el.innerText || el.textContent);
      if (!text || text.length < 8) continue;

      const lower = text.toLowerCase();

      const looksLikeEvent =
        lower.includes("trening") ||
        lower.includes("piro") ||
        lower.includes("idpa") ||
        lower.includes("rezerw") ||
        lower.includes("wolne") ||
        lower.includes("zarezerwuj") ||
        /\d{1,2}:\d{2}/.test(text);

      if (!looksLikeEvent) continue;

      results.push({
        title: text,
        url: window.location.href
      });
    }

    const unique = new Map();

    for (const item of results) {
      const key = `${item.title}::${item.url}`;
      unique.set(key, item);
    }

    return Array.from(unique.values());
  });

  return events
    .map((event) => ({
      title: normalizeText(event.title),
      url: event.url
    }))
    .filter((event) => event.title.length > 0);
}

function getEventKey(event) {
  return `${event.title}::${event.url}`;
}

async function checkEvents() {
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

    console.log(`Znaleziono wydarzeń/kandydatów: ${events.length}`);

    if (firstRun) {
      for (const event of events) {
        knownEvents.add(getEventKey(event));
      }

      if (NOTIFY_ON_START) {
        await sendTelegram(
          `🤖 Bot Reservio wystartował.\n\nZnalezione aktualnie terminy: <b>${events.length}</b>\n\n${RESERVIO_URL}`
        );
      } else {
        await sendTelegram(
          `🤖 Bot Reservio wystartował i monitoruje terminy.\n\nStrona: ${RESERVIO_URL}`
        );
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
      const message =
        `🚨 <b>Nowy termin / wydarzenie w Reservio</b>\n\n` +
        `${event.title}\n\n` +
        `🔗 ${event.url}`;

      await sendTelegram(message);
    }

    if (newEvents.length > 0) {
      console.log(`Wysłano powiadomienia: ${newEvents.length}`);
    }
  } catch (error) {
    console.error("Błąd podczas sprawdzania:", error.message);

    try {
      await sendTelegram(
        `⚠️ Bot Reservio napotkał błąd:\n\n<code>${error.message}</code>`
      );
    } catch (_) {}
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function main() {
  console.log("Reservio Alert Bot startuje...");

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
