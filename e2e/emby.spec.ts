import { test, expect } from "@playwright/test";

test("choose a show, review guesses, save mappings and recover from empty/error scopes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/admin");
  await page.getByRole("button", { name: "Emby", exact: true }).click();
  await page.getByRole("button", { name: "Load Emby libraries" }).click();
  await page.getByLabel("Emby library", { exact: true }).selectOption("tv");
  await expect(page.getByLabel("TV show", { exact: true })).toBeEnabled();
  await page.getByLabel("TV show", { exact: true }).selectOption("f1");
  await page.getByRole("button", { name: "Inspect episodes" }).click();
  await expect(
    page.getByRole("heading", { name: "Review suggestions" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Weekend for Episode 1", { exact: true }),
  ).toHaveValue("2026-singapore");
  await expect(
    page.getByLabel("Session for Episode 1", { exact: true }),
  ).toHaveValue("sprint-qualifying");
  await expect(
    page.getByLabel("Weekend for Singapore Race", { exact: true }),
  ).toHaveValue("2025-singapore");
  await expect(
    page.getByLabel("Weekend for Unidentified session", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByText("Unrelated episode", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save 2 suggestions" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Inspect episodes" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: ".local/emby-selection/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: ".local/emby-selection/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save 2 suggestions" }).click();
  await expect(page.getByText("Mapped", { exact: true })).toHaveCount(2);
  await page.reload();
  await page.getByRole("button", { name: "Emby", exact: true }).click();
  await expect(page.getByLabel("TV show", { exact: true })).toHaveValue("f1");
  await page.getByRole("button", { name: "Inspect episodes" }).click();
  await expect(page.getByText("Mapped", { exact: true })).toHaveCount(2);
  await page.getByLabel("TV show", { exact: true }).selectOption("empty");
  await expect(
    page.getByRole("heading", { name: "Review suggestions" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect episodes" }).click();
  await expect(page.getByRole("status")).toContainText("No episodes found");
  await page.getByLabel("TV show", { exact: true }).selectOption("unavailable");
  await page.getByRole("button", { name: "Inspect episodes" }).click();
  await expect(page.getByRole("alert")).toContainText("Emby returned 503");
  await page.getByRole("button", { name: "Load Emby libraries" }).click();
  await page.getByLabel("Emby library", { exact: true }).selectOption("sports");
  await expect(page.getByLabel("TV show", { exact: true })).toHaveValue("");
  await expect(
    page
      .getByLabel("TV show", { exact: true })
      .getByRole("option", { name: "Formula 2", exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByLabel("TV show", { exact: true })
      .getByRole("option", { name: "Formula 1", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
