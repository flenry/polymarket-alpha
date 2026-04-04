import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to a page and wait for the network to settle. */
async function goto(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Navigation & Layout
// ---------------------------------------------------------------------------

test.describe("Navigation & Layout", () => {
  test("root / redirects to /alerts", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/alerts");
    expect(page.url()).toContain("/alerts");
  });

  test("sidebar is visible with all 5 nav links", async ({ page }) => {
    await goto(page, "/alerts");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    const links = ["Alerts", "Signals", "Markets", "Wallets", "Health"];
    for (const label of links) {
      await expect(sidebar.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("sidebar nav links have correct hrefs", async ({ page }) => {
    await goto(page, "/alerts");
    const sidebar = page.locator("aside");

    const expected = [
      { label: "Alerts", href: "/alerts" },
      { label: "Signals", href: "/signals" },
      { label: "Markets", href: "/markets" },
      { label: "Wallets", href: "/wallets" },
      { label: "Health", href: "/health" },
    ];

    for (const { label, href } of expected) {
      const link = sidebar.getByRole("link", { name: label });
      await expect(link).toHaveAttribute("href", href);
    }
  });

  test("active nav item is highlighted on /alerts", async ({ page }) => {
    await goto(page, "/alerts");
    const alertsLink = page.locator("aside").getByRole("link", { name: "Alerts" });
    // Active class adds bg-slate-100 and text-blue-600
    await expect(alertsLink).toHaveClass(/bg-slate-100/);
  });

  test("active nav item is highlighted on /signals", async ({ page }) => {
    await goto(page, "/signals");
    const signalsLink = page.locator("aside").getByRole("link", { name: "Signals" });
    await expect(signalsLink).toHaveClass(/bg-slate-100/);
  });

  test("active nav item is highlighted on /health", async ({ page }) => {
    await goto(page, "/health");
    const healthLink = page.locator("aside").getByRole("link", { name: "Health" });
    await expect(healthLink).toHaveClass(/bg-slate-100/);
  });
});

// ---------------------------------------------------------------------------
// Alerts page (/alerts)
// ---------------------------------------------------------------------------

test.describe("Alerts page", () => {
  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/alerts");
    expect(errors).toHaveLength(0);
  });

  test("h1 is visible", async ({ page }) => {
    await goto(page, "/alerts");
    await expect(page.locator("main h1")).toBeVisible();
  });

  test("h1 text is 'Whale Alerts'", async ({ page }) => {
    await goto(page, "/alerts");
    await expect(page.locator("main h1")).toHaveText("Whale Alerts");
  });

  test("4 KPI stat cards are visible", async ({ page }) => {
    await goto(page, "/alerts");
    // StatCard renders a card with a title + value — each is a div with border
    // The alerts page renders exactly 4 StatCards in a grid
    const statCards = page
      .locator(".grid")
      .first()
      .locator(":scope > div");
    await expect(statCards).toHaveCount(4);
  });

  test("empty state message is visible when no data", async ({ page }) => {
    await goto(page, "/alerts");
    // AlertsTable shows this message when alerts array is empty
    await expect(
      page.getByText(/no whale alerts yet/i)
    ).toBeVisible({ timeout: 8000 });
  });

  test("table column headers match spec when data present (graceful)", async ({
    page,
  }) => {
    await goto(page, "/alerts");
    // When alerts is empty the table is replaced by the empty-state div.
    // We confirm the table is NOT present (empty state takes over).
    const emptyState = page.getByText(/no whale alerts yet/i);
    const isEmptyState = await emptyState.isVisible({ timeout: 6000 }).catch(() => false);
    if (!isEmptyState) {
      // If there is live data the table headers should be present
      for (const col of [
        "Time", "Market", "Side", "Value (USDC)", "Wallet",
        "σ above mean", "% daily vol", "Enriched?",
      ]) {
        await expect(page.getByRole("columnheader", { name: col })).toBeVisible();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Signals page (/signals)
// ---------------------------------------------------------------------------

test.describe("Signals page", () => {
  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/signals");
    expect(errors).toHaveLength(0);
  });

  test("h1 is visible with text 'Signals'", async ({ page }) => {
    await goto(page, "/signals");
    await expect(page.locator("main h1")).toHaveText("Signals");
  });

  test("signal sparkline container is visible", async ({ page }) => {
    await goto(page, "/signals");
    // SignalSparkline renders a div with the label "Signal Volume"
    await expect(
      page.getByText(/Signal Volume/i)
    ).toBeVisible({ timeout: 8000 });
  });

  test("filter bar is visible with signal type buttons", async ({ page }) => {
    await goto(page, "/signals");
    // Each signal type is a <button> in the filter bar
    const filterBar = page.locator(".flex.flex-wrap.items-center.gap-4").first();
    await expect(filterBar).toBeVisible({ timeout: 8000 });

    for (const type of [
      "WHALE_TRADE",
      "ORDER_BOOK_IMBALANCE",
      "PRICE_IMPACT_ANOMALY",
      "SENTIMENT_VELOCITY",
    ]) {
      await expect(filterBar.getByRole("button", { name: type })).toBeVisible();
    }
  });

  test("confidence slider input is visible", async ({ page }) => {
    await goto(page, "/signals");
    await expect(page.getByText(/Min conf:/i)).toBeVisible({ timeout: 8000 });
  });

  test("time range selector is visible", async ({ page }) => {
    await goto(page, "/signals");
    // Select renders a combobox trigger — target the role directly
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 8000 });
  });

  test("signals table headers are visible", async ({ page }) => {
    await goto(page, "/signals");
    // SignalsTable always renders the table (empty-row is inside the tbody)
    for (const col of [
      "Time", "Market", "Signal Type", "Direction", "Confidence",
    ]) {
      await expect(page.getByRole("columnheader", { name: col })).toBeVisible({ timeout: 8000 });
    }
  });

  test("signals empty state message is visible when no data", async ({
    page,
  }) => {
    await goto(page, "/signals");
    await expect(
      page.getByText(/No signals in the selected window/i)
    ).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Markets page (/markets)
// ---------------------------------------------------------------------------

test.describe("Markets page", () => {
  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/markets");
    expect(errors).toHaveLength(0);
  });

  test("h1 is visible with text 'Market Heat Map'", async ({ page }) => {
    await goto(page, "/markets");
    await expect(page.locator("main h1")).toHaveText("Market Heat Map");
  });

  test("empty state renders gracefully when no data", async ({ page }) => {
    await goto(page, "/markets");
    await expect(
      page.getByText(/No signal activity in the last 24 hours/i)
    ).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Wallets page (/wallets)
// ---------------------------------------------------------------------------

test.describe("Wallets page", () => {
  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/wallets");
    expect(errors).toHaveLength(0);
  });

  test("h1 is visible with text 'Wallet Leaderboard'", async ({ page }) => {
    await goto(page, "/wallets");
    await expect(page.locator("main h1")).toHaveText("Wallet Leaderboard");
  });

  test("filter controls are visible (min trades, min volume)", async ({
    page,
  }) => {
    await goto(page, "/wallets");
    await expect(page.getByText(/Min trades/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/Min volume/i)).toBeVisible({ timeout: 8000 });
    // Two number inputs
    const inputs = page.locator("input[type='number']");
    await expect(inputs).toHaveCount(2);
  });

  test("table column headers are correct", async ({ page }) => {
    await goto(page, "/wallets");
    for (const col of [
      "Rank", "Wallet", "Total Vol", "Win Rate",
      "Whale Trades", "Last Seen",
    ]) {
      await expect(page.getByRole("columnheader", { name: col, exact: true })).toBeVisible({ timeout: 8000 });
    }
    // "Trades" and "Whale Trades" share the word — use exact match
    await expect(page.getByRole("columnheader", { name: "Trades", exact: true })).toBeVisible({ timeout: 8000 });
  });

  test("empty state renders when no wallets match filters", async ({
    page,
  }) => {
    await goto(page, "/wallets");
    await expect(
      page.getByText(/No wallets match the current filters/i)
    ).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Health page (/health)
// ---------------------------------------------------------------------------

test.describe("Health page", () => {
  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/health");
    expect(errors).toHaveLength(0);
  });

  test("h1 is visible with text 'Pipeline Health'", async ({ page }) => {
    await goto(page, "/health");
    await expect(page.locator("main h1")).toHaveText("Pipeline Health");
  });

  test("auto-refresh subtitle is visible", async ({ page }) => {
    await goto(page, "/health");
    await expect(
      page.getByText(/refreshes every 10s/i)
    ).toBeVisible();
  });

  test("4 health cards are visible with correct names", async ({ page }) => {
    await goto(page, "/health");
    for (const name of ["LiveDataWs", "ClobWsPool", "GammaPoller", "DB"]) {
      await expect(page.getByText(name)).toBeVisible({ timeout: 8000 });
    }
  });

  test("each health card has a status indicator dot", async ({ page }) => {
    await goto(page, "/health");
    // Each HealthCard renders a rounded-full dot span
    const dots = page.locator("span.rounded-full");
    // 4 cards × 1 dot each
    await expect(dots).toHaveCount(4, { timeout: 8000 });
  });

  test("health cards show 'No data' when DB is unreachable", async ({
    page,
  }) => {
    await goto(page, "/health");
    // statusInfo(null) → label: "No data"
    const noDatas = page.getByText("No data");
    await expect(noDatas.first()).toBeVisible({ timeout: 8000 });
  });

  test("trade feed subtitle is visible in LiveDataWs card", async ({
    page,
  }) => {
    await goto(page, "/health");
    await expect(page.getByText("Trade feed")).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// Accessibility basics
// ---------------------------------------------------------------------------

test.describe("Accessibility", () => {
  const pages = [
    { path: "/alerts", h1: "Whale Alerts" },
    { path: "/signals", h1: "Signals" },
    { path: "/markets", h1: "Market Heat Map" },
    { path: "/wallets", h1: "Wallet Leaderboard" },
    { path: "/health", h1: "Pipeline Health" },
  ];

  for (const { path, h1 } of pages) {
    test(`${path} has exactly one <h1>`, async ({ page }) => {
      await goto(page, path);
      await expect(page.locator("h1")).toHaveCount(1);
    });

    test(`${path} h1 text is '${h1}'`, async ({ page }) => {
      await goto(page, path);
      await expect(page.locator("main h1")).toHaveText(h1);
    });
  }

  test("all sidebar nav links are <a> elements", async ({ page }) => {
    await goto(page, "/alerts");
    const nav = page.locator("aside nav");
    const links = nav.locator("a");
    await expect(links).toHaveCount(5);
  });

  test("no console errors on /alerts page load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/alerts");
    expect(errors).toHaveLength(0);
  });

  test("no console errors on /signals page load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/signals");
    expect(errors).toHaveLength(0);
  });

  test("no console errors on /health page load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await goto(page, "/health");
    expect(errors).toHaveLength(0);
  });
});
