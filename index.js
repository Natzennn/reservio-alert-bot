const { chromium } = require("playwright");
const TelegramBot = require("node-telegram-bot-api");

const RESERVIO_URL = process.env.RESERVIO_URL || "https://test1874.reservio.com/events";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const NOTIFY_ON_START = process.env.NOTIFY_ON_START === "true";
const WEEKS_AHEAD = Number(process.env.WEEKS_AHEAD || 8);

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
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeCurrentPageEvents(page) {
  const events = await page.evaluate(() => {
    function clean(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    const results = [];

    const selectors = [
      'a[href*="/events/"]',
      'a[href*="/event/"]',
      'a[href*="/booking"]',
      '[data-testid*="event"]',
      '[class*="event"]',
      '[class*="Event"]',
      "article",
      "button"
    ];

    const elements = Array.from(document.querySelectorAll(selectors.join(",")));

    for (const el of elements) {
      const text = clean(el.innerText || el.textContent);
      if (!text || text.length < 8) continue;

      const href = el.href || window.location.href;
      const lower = text.toLowerCase();

      const looksLikeEvent =
        lower.includes("trening") ||
        lower.includes("piro") ||
        lower.includes("idpa") ||
        lower.includes("rezerw") ||
        lower.includes("zarezerwuj") ||
        lower.includes("wolne") ||
        lower.includes("miejsc") ||
        /\d{1,2}:\d{2}/.test(text);

      if (!looksLikeEvent) continue;

      results.push({
        title: text,
        url: href
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

async function clickNextWeek(page) {
  const possibleNextButtons = [
    'button[aria-label*="Next"]',
    'button[aria-label*="Następ"]',
    'button[aria-label*="Dalej"]',
    'a[aria-label*="Next"]',
    'a[aria-label*="Następ"]',
    'a[aria-label*="Dalej"]',
    'button:has-text(">")',
    'a:has-text(">")',
    'button:has-text("›")',
    'a:has-text("›")',
    'button:has-text("Następny")',
    'a:has-text("Następny")',
    'button:has-text("Następny tydzień")',
    'a:has-text("Następny tydzień")'
  ];

  for (const selector of possibleNextButtons) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.count()) {
        if (await locator.isVisible()) {
          await locator.click({ timeout: 5000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          return true;
        }
      }
    } catch (_) {}
  }

  const clickedByText = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, a"));

    const next = candidates.find((el) => {
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const title = (el.getAttribute("title") || "").trim().toLowerCase();

      return (
        text === ">" ||
        text === "›" ||
        text.includes("następ") ||
        text.includes("dalej") ||
        aria.includes("next") ||
        aria.includes("następ") ||
        aria.includes("dalej") ||
        title.includes("next") ||
        title.includes("następ") ||
        title.includes("dalej")
      );
    });

    if (!next) return false;

    next.click();
    return true;
  });

  if (clickedByText) {
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    return true;
  }

  return false;
}

async function scrapeReservioEvents(page) {
  await page.goto(RESERVIO_URL, {
    waitUntil: "networkidle",
    timeout: 45000
  });

  await page.waitForTimeout(3000);

  const allEvents = [];
  const seenPages = new Set();

  for (let week = 0; week <= WEEKS_AHEAD; week++) {
    const currentUrl = page.url();

    if (seenPages.has(currentUrl)) {
      console.log("Ten sam URL powtórzył się — kończę przechodzenie po tygodniach.");
      break;
    }

    seenPages.add(currentUrl);

    console.log(`Skanuję tydzień ${week + 1}/${WEEKS_AHEAD + 1}: ${currentUrl}`);

    const events = await scrapeCurrentPageEvents(page);
    allEvents.push(...events);

    if (week === WEEKS_AHEAD) break;

    const moved = await clickNextWeek(page);

    if (!moved) {
      console.log("Nie udało się znaleźć przycisku następnego tygodnia.");
      break;
    }

    await sleep(1000);
  }

  const unique = new Map();

  for (const event of allEvents) {
    const key = getEventKey(event);
    unique.set(key, event);
  }

  return Array.from(unique.values());
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

    console.log(`Znaleziono łącznie wydarzeń/kandydatów: ${events.length}`);

    if (firstRun) {
      for (const event of events) {
        knownEvents.add(getEventKey(event));
      }

      if (NOTIFY_ON_START) {
        const preview = events
          .slice(0, 10)
          .map((event, index) => `${index + 1}. ${event.title}`)
          .join("\n\n");

        await sendTelegram(
          `🤖 Bot Reservio wystartował.\n\n` +
          `Sprawdzam tygodni do przodu: <b>${WEEKS_AHEAD}</b>\n` +
          `Znalezione aktualnie terminy: <b>${events.length}</b>\n\n` +
          `${preview || "Brak widocznych terminów."}\n\n` +
          `${RESERVIO_URL}`
        );
      } else {
        await sendTelegram(
          `🤖 Bot Reservio wystartował i monitoruje terminy.\n\n` +
          `Sprawdzam tygodni do przodu: <b>${WEEKS_AHEAD}</b>\n` +
          `Strona: ${RESERVIO_URL}`
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
  console.log(`WEEKS_AHEAD=${WEEKS_AHEAD}`);

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
