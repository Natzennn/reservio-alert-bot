const { chromium } = require("playwright");
const TelegramBot = require("node-telegram-bot-api");

const RESERVIO_URL = process.env.RESERVIO_URL || "https://test1874.reservio.com/events";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 120000);
const WEEKS_AHEAD = Number(process.env.WEEKS_AHEAD || 8);

// true = przy starcie wyśle wszystkie aktualnie znalezione terminy
// false = przy starcie tylko je zapamięta, a potem wyśle wyłącznie nowe
const NOTIFY_ON_START = process.env.NOTIFY_ON_START !== "false";

// true = wyśle debug na Telegram i do logów
const DEBUG_MODE = process.env.DEBUG_MODE !== "false";

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

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function chunkText(text, maxLength = 3500) {
  const chunks = [];
  let current = String(text || "");

  while (current.length > 0) {
    chunks.push(current.slice(0, maxLength));
    current = current.slice(maxLength);
  }

  return chunks;
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
      '[class*="calendar"]',
      '[class*="Calendar"]',
      '[class*="booking"]',
      '[class*="Booking"]',
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
        lower.includes("available") ||
        lower.includes("book") ||
        lower.includes("spots") ||
        lower.includes("capacity") ||
        /\d{1,2}:\d{2}/.test(text) ||
        /\d{1,2}\.\d{1,2}/.test(text);

      if (!looksLikeEvent) continue;

      results.push({
        title: text,
        url: href
      });
    }

    const unique = new Map();

    for (const item of results) {
      unique.set(`${item.title}::${item.url}`, item);
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

async function getVisiblePageDebug(page) {
  return await page.evaluate(() => {
    function clean(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    const buttonsAndLinks = Array.from(document.querySelectorAll("button, a"))
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.textContent);
        const aria = el.getAttribute("aria-label") || "";
        const title = el.getAttribute("title") || "";
        const href = el.href || "";

        return {
          index,
          text,
          aria,
          title,
          href,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            window.getComputedStyle(el).visibility !== "hidden" &&
            window.getComputedStyle(el).display !== "none"
        };
      })
      .filter((item) => item.visible)
      .slice(0, 80);

    const bodyText = clean(document.body.innerText || document.body.textContent || "");

    return {
      url: window.location.href,
      title: document.title,
      bodyText: bodyText.slice(0, 6000),
      buttonsAndLinks
    };
  });
}

async function clickNextWeek(page) {
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
    'button:has-text("›")',
    'button:has-text(">")',
    'a:has-text("›")',
    'a:has-text(">")',
    'button:has(svg)',
    'a:has(svg)'
  ];

  for (const selector of possibleSelectors) {
    const count = await page.locator(selector).count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const el = page.locator(selector).nth(i);

      if (!(await el.isVisible().catch(() => false))) continue;

      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;

      if (box.x > 600) {
        await el.click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2500);
        return true;
      }
    }
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

  for (let week = 0; week <= WEEKS_AHEAD; week++) {
    console.log(`Skanuję tydzień ${week + 1}/${WEEKS_AHEAD + 1}: ${page.url()}`);

    const events = await scrapeCurrentPageEvents(page);
    console.log(`W tym tygodniu znaleziono kandydatów: ${events.length}`);

    if (DEBUG_MODE) {
      console.log(`=== WYDARZENIA WIDZIANE W TYGODNIU ${week + 1} ===`);
      events.forEach((event, index) => {
        console.log(`${index + 1}. ${event.title}`);
        console.log(event.url);
      });
      console.log("============================================");
    }

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
    unique.set(getEventKey(event), event);
  }

  return Array.from(unique.values());
}

async function notifyCurrentEventsAtStart(events) {
  await sendTelegram(
    `🤖 <b>Bot Reservio wystartował</b>\n\n` +
      `Strona: ${escapeHtml(RESERVIO_URL)}\n` +
      `Sprawdzam tygodni do przodu: <b>${WEEKS_AHEAD}</b>\n` +
      `Znalezione aktualnie terminy: <b>${events.length}</b>`
  );

  if (events.length === 0) {
    await sendTelegram("Brak aktualnie widocznych terminów.");
    return;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    await sendTelegram(
      `📌 <b>Termin dostępny teraz</b> (${i + 1}/${events.length})\n\n` +
        `${escapeHtml(event.title)}\n\n` +
        `🔗 ${escapeHtml(event.url)}`
    );

    await sleep(400);
  }
}

async function sendDebugToTelegram(page, events) {
  if (!DEBUG_MODE) return;

  const debug = await getVisiblePageDebug(page);

  const eventList = events
    .map((event, index) => `${index + 1}. ${escapeHtml(event.title)}\n${escapeHtml(event.url)}`)
    .join("\n\n");

  await sendTelegram(
    `🔍 <b>DEBUG Reservio</b>\n\n` +
      `Bot widzi wydarzeń: <b>${events.length}</b>\n` +
      `URL: ${escapeHtml(debug.url)}\n` +
      `Tytuł strony: ${escapeHtml(debug.title)}\n\n` +
      `${eventList || "Brak wydarzeń"}`
  );

  const buttonsText = debug.buttonsAndLinks
    .map((item) => {
      return (
        `#${item.index} x:${item.x} y:${item.y} w:${item.width} h:${item.height}\n` +
        `text: ${item.text || "-"}\n` +
        `aria: ${item.aria || "-"}\n` +
        `title: ${item.title || "-"}\n` +
        `href: ${item.href || "-"}`
      );
    })
    .join("\n\n");

  for (const chunk of chunkText(buttonsText, 3200).slice(0, 2)) {
    await sendTelegram(`🔘 <b>DEBUG przyciski/linki</b>\n\n<pre>${escapeHtml(chunk)}</pre>`);
    await sleep(400);
  }

  for (const chunk of chunkText(debug.bodyText, 3200).slice(0, 2)) {
    await sendTelegram(`📄 <b>DEBUG tekst strony</b>\n\n<pre>${escapeHtml(chunk)}</pre>`);
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

    console.log(`Znaleziono łącznie wydarzeń/kandydatów: ${events.length}`);

    console.log("=== WSZYSTKIE WYDARZENIA WIDZIANE PRZEZ BOTA ===");
    events.forEach((event, index) => {
      console.log(`${index + 1}. ${event.title}`);
      console.log(event.url);
    });
    console.log("================================================");

    if (firstRun) {
      for (const event of events) {
        knownEvents.add(getEventKey(event));
      }

      await sendDebugToTelegram(page, events);

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
        `🚨 <b>Nowy termin / wydarzenie w Reservio</b>\n\n` +
          `${escapeHtml(event.title)}\n\n` +
          `🔗 ${escapeHtml(event.url)}`
      );
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
  console.log(`DEBUG_MODE=${DEBUG_MODE}`);

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
