import { test, expect, type Page } from "@playwright/test";

const shots = ".local/studio";
const preview = (page: Page) =>
  page.getByRole("img", { name: /thumbnail preview/ });
// Glyph paths are drawn in order: title, session label, then year/round.
const firstPathFill = (page: Page, index: number) =>
  preview(page)
    .locator("path")
    .nth(index)
    .evaluate((path) => path.getAttribute("fill"));

test("refine a thumbnail with feedback, recolour overlays per session, and approve it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin");
  await page
    .getByRole("combobox", { name: "Race weekend" })
    .selectOption("2026-singapore");
  await page.getByRole("button", { name: "Open studio" }).click();
  await expect(page).toHaveURL(/studio=2026-singapore/);
  await expect(page.getByText("IMAGE STUDIO")).toBeVisible();

  // The live thumbnail is the starting point.
  const original = page.getByRole("button", { name: "Version 1" });
  await expect(original).toHaveAttribute("aria-pressed", "true");
  await expect(original).toContainText("Live");
  await expect(page.getByText("5 of 5 attempts left this month")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this thumbnail" }),
  ).toBeDisabled();

  // A fresh image, then feedback on it, each become a new draft version.
  await page
    .getByLabel("Extra direction for a fresh image (optional)")
    .fill("Feature the Singapore Flyer");
  await page.getByRole("button", { name: "Generate fresh" }).click();
  await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 15000 },
  );
  await page
    .getByLabel(/Feedback on version #2/)
    .fill("Change the car colour to pink");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const revised = page.getByRole("button", { name: "Version 3" });
  await expect(revised).toHaveAttribute("aria-pressed", "true", {
    timeout: 15000,
  });
  await expect(revised).toContainText("Change the car colour to pink");
  await expect(page.getByText("3 of 5 attempts left this month")).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(original).toContainText("Live");

  // Linked colours apply everywhere; an unlinked one can differ per session.
  await page.getByLabel("Venue title colour hex").fill("#ffd400");
  await expect.poll(() => firstPathFill(page, 0)).toBe("#ffd400");
  const sessionLink = page.getByRole("button", {
    name: "Link Session label colour across sessions",
  });
  await sessionLink.click();
  await expect(sessionLink).toHaveAttribute("aria-pressed", "false");
  await page
    .getByLabel("Session label colour for Race hex", { exact: true })
    .fill("#00e5ff");
  const titleGlyphs = "SINGAPORE".length;
  await expect.poll(() => firstPathFill(page, titleGlyphs)).toBe("#00e5ff");
  await page
    .getByRole("group", { name: "Session" })
    .getByRole("button", { name: "Race Qualifying" })
    .click();
  await expect.poll(() => firstPathFill(page, titleGlyphs)).not.toBe("#00e5ff");
  await page
    .getByRole("group", { name: "Session" })
    .getByRole("button", { name: "Race", exact: true })
    .click();
  // Full-page captures draw the sticky header at the current scroll offset.
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });
  await page.evaluate(() => scrollTo(0, 400));
  await page.screenshot({ path: `${shots}/desktop-scrolled.png` });
  await page.evaluate(() => scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The draft is shared and survives leaving the studio.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(revised).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Venue title colour hex")).toHaveValue(
    "#ffd400",
  );
  await expect(
    page.getByLabel("Session label colour for Race hex", { exact: true }),
  ).toHaveValue("#00e5ff");

  await page.getByRole("button", { name: "Use this thumbnail" }).click();
  await expect(
    page.getByText(/Thumbnail applied to all 4 sessions/),
  ).toBeVisible();
  await expect(revised).toContainText("Live");
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/approved.png`, fullPage: true });

  // Discarding a later draft restores the approved colours.
  await page.getByLabel("Venue title colour hex").fill("#ffffff");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByLabel("Venue title colour hex")).toHaveValue(
    "#ffd400",
  );

  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect(page).not.toHaveURL(/studio=/);
  await expect(page.getByRole("button", { name: "Open studio" })).toBeVisible();
  expect(errors).toEqual([]);
});
