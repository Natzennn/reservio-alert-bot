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
let isChecking = false;

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

function getEventKey(event) {
  return `${event.title}::${event.url}`;
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
  const beforeUrl = page.url();

  const possibleSelectors = [
    'button[aria-label*="Next"]',
    'button[aria-label*="next"]',
    'button[aria-label*="Następ"]',
    'button[aria-label*="następ"]',
    'button[aria-label*="Dalej"]',
    'button[aria-label*="dalej"]',
    'a[aria-label*="Next"]',
    'a[aria-label*="next"]',
    'a[aria-label*="Następ"]',
    'a[aria-label*="następ"]',
    'a[aria-label*="Dalej"]',
    'a[aria-label*="dalej"]',
    'button[title*="Next"]',
    'button[title*="next"]',
    'button[title*="Następ"]',
    'button[title*="następ"]',
    'a[title*="Next"]',
    'a[title*="next"]',
    'a[title*="Następ"]',
    'a[title*="następ"]',
    'button:has-text("›")',
    'button:has-text(">")',
    'a:has-text("›")',
    'a:has-text(">")',
    'button:has(svg)',
    'a:has(svg)'
  ];

  for (const selector of possibleSelectors) {
    try {
      const count = await page.locator(selector).count();

      for (let i = 0; i < count; i++) {
        const el = page.locator(selector).nth(i);

        if (!(await el.isVisible().catch(() => false))) continue;

        const box = await el.boundingBox().catch(() => null);
        if (!box) continue;

        // Szukamy przycisku po prawej stronie, bo zwykle oznacza "następny tydzień"
        if (box.x > 600) {
          await el.click({ timeout: 5000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2500);

          const afterUrl = page.url();
          console.log(`Kliknięto możliwy następny tydzień. URL przed: ${beforeUrl}, URL po: ${afterUrl}`);

          return true;
        }
      }
    } catch (_) {}
  }

  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, a"))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").trim();
        const aria = (el.getAttribute("aria-label") || "").trim();
        const title = (el.getAttribute("title") || "").trim();

        return {
          el,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          aria,
          title,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            window.getComputedStyle(el).visibility !== "hidden" &&
            window.getComputedStyle(el).display !== "none"
        };
      })
      .filter((item) => item.visible)
      .filter((item) => item.y < 350)
      .filter((item) => item.x > window.innerWidth / 2);

    const direct = candidates.find((item) => {
      const combined = `${item.text} ${item.aria} ${item.title}`.toLowerCase();

      return (
        combined.includes("next") ||
        combined.includes("następ") ||
        combined.includes("dalej") ||
        combined.includes("›") ||
        combined.includes(">")
      );
    });

    if (direct) {
      direct.el.click();
      return true;
    }

    // Awaryjnie klikamy najbardziej prawy mały przycisk w górnej części kalendarza
    const sorted = candidates
      .filter((item) => item.width <= 120 && item.height <= 120)
      .sort((a, b) => b.x - a.x);

    if (sorted[0]) {
      sorted[0].el.click();
      return true;
    }

    return false;
  });

  if (clicked) {
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const afterUrl = page.url();
    console.log(`Kliknięto awaryjnie możliwy następny tydzień. URL przed: ${beforeUrl}, URL po: ${afterUrl}`);

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
  const seenStates = new Set();

  for (let week = 0; week <= WEEKS_AHEAD; week++) {
    const currentUrl = page.url();

    const pageHeader = await page
      .locator("body")
      .innerText({ timeout: 5000 })
      .catch(() => "");

    const stateKey = `${currentUrl}::${pageHeader.slice(0, 500)}`;

    if (seenStates.has(stateKey)) {
      console.log("Ten sam widok powtórzył się — kończę przechodzenie po tygodniach.");
      break;
    }

    seenStates.add(stateKey);

    console.log(`Skanuję tydzień ${week + 1}/${WEEKS_AHEAD + 1}: ${currentUrl}`);

    const events = await scrapeCurrentPageEvents(page);
    console.log(`W tym tygodniu znaleziono kandydatów: ${events.length}`);

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
    } else {
      console.log("Brak nowych terminów.");
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

    isChecking = false;
  }
}

async function main() {
  console.log("Reservio Alert Bot startuje...");
  console.log(`WEEKS_AHEAD=${WEEKS_AHEAD}`);
  console.log(`CHECK_INTERVAL_MS=${CHECK_INTERVAL_MS}`);
  console.log(`RESERVIO_URL=${RESERVIO_URL}`);

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
