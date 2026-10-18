import { test, expect } from "@playwright/test";

test("settings show provider spending and recover after a failed refresh", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/admin");
  const card = page.getByRole("region", { name: "OpenRouter spending" });
  await expect(card.getByText("$12.3456", { exact: true })).toBeVisible();
  await expect(card.getByText("$3.50", { exact: true })).toBeVisible();
  await expect(card.getByText("$1.25", { exact: true })).toBeVisible();
  await expect(card.getByText("$0.0042", { exact: true })).toBeVisible();
  const response = await page.request.get("/api/admin/usage");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({
    total: 12.3456,
    daily: 0.0042,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: ".local/spending/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".local/spending/mobile.png" });

  await page.route("**/api/admin/usage", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "OpenRouter spending is unavailable (503)." },
    }),
  );
  await card.getByRole("button", { name: "Refresh spending" }).click();
  await expect(card.getByRole("alert")).toContainText(
    "Showing the last fetched amounts",
  );
  await expect(card.getByText("$12.3456", { exact: true })).toBeVisible();

  await page.route("**/api/admin/usage", (route) =>
    route.fulfill({
      json: {
        total: 13,
        daily: 0,
        weekly: 0,
        monthly: 0,
        byokTotal: null,
        fetchedAt: new Date().toISOString(),
      },
    }),
  );
  await card.getByRole("button", { name: "Refresh spending" }).click();
  await expect(card.getByText("$13.00", { exact: true })).toBeVisible();
  await expect(card.getByText("$0.00", { exact: true })).toHaveCount(3);
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("loading, unavailable and retry states leave the settings usable", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/admin/usage", async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      json: { error: "OpenRouter spending is unavailable (503)." },
    });
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: "OpenRouter spending" });
  await expect(card.getByRole("status")).toContainText("Loading spending");
  await expect(
    card.getByRole("button", { name: "Refresh spending" }),
  ).toBeDisabled();
  release();
  await expect(card.getByRole("alert")).toContainText("unavailable (503)");
  await expect(card.getByText("$0.00")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/api/admin/usage");
  await card.getByRole("button", { name: "Refresh spending" }).click();
  await expect(card.getByText("$12.3456", { exact: true })).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("without an OpenRouter key settings explain how to view spending", async ({
  page,
}) => {
  let usageRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/admin/usage")) usageRequests++;
  });
  await page.route("**/api/admin/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    status.configured.openrouter = false;
    await route.fulfill({ json: status });
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: "OpenRouter spending" });
  await expect(card).toContainText("Connect OpenRouter to view spending.");
  await expect(
    card.getByRole("button", { name: "Refresh spending" }),
  ).toBeDisabled();
  expect(usageRequests).toBe(0);
});
