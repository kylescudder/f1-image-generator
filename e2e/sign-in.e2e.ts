import { test, expect } from "@playwright/test";

// Exercise the actual Clerk form, substituting only the identity boundary.
// Public configuration/assets load normally; identity requests never leave here.
test.beforeEach(async ({ page }) => {
  await page.route(
    "https://clerk.paddock.thescudders.org/v1/client**",
    (route) => {
      const headers = {
        "access-control-allow-origin": "http://localhost:4321",
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          route.request().headers()["access-control-request-headers"] ||
          "content-type",
        vary: "Origin",
      };
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      if (route.request().method() !== "GET")
        return route.fulfill({
          status: 422,
          headers,
          json: {
            errors: [
              {
                code: "form_identifier_not_found",
                message: "Couldn't find your account.",
                long_message: "Couldn't find your account.",
                meta: { param_name: "identifier" },
              },
            ],
          },
        });
      return route.fulfill({
        headers,
        json: {
          response: {
            object: "client",
            id: "client_fixture",
            sessions: [],
            sign_in: null,
            sign_up: null,
            last_active_session_id: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
          client: null,
        },
      });
    },
  );
});

test("Clerk fixture supports credentialed CORS requests and preflight", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("textbox", { name: "Email address", exact: true }),
  ).toBeVisible({ timeout: 30000 });

  for (const method of ["OPTIONS", "GET", "POST"]) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("cors-check") &&
        response.request().method() === method,
    );
    const result = await page.evaluate(async (method) => {
      const response = await fetch(
        "https://clerk.paddock.thescudders.org/v1/client?cors-check",
        {
          method,
          credentials: "include",
          ...(method === "POST"
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ identifier: "unknown@example.invalid" }),
              }
            : {}),
        },
      );
      return {
        status: response.status,
        body:
          method === "OPTIONS" ? await response.text() : await response.json(),
      };
    }, method);
    const headers = await (await responsePromise).allHeaders();
    expect(headers["access-control-allow-origin"]).toBe(
      "http://localhost:4321",
    );
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(headers["access-control-allow-headers"]).toContain("content-type");
    expect(result.status).toBe(
      method === "OPTIONS" ? 204 : method === "GET" ? 200 : 422,
    );
    if (method === "OPTIONS") expect(result.body).toBe("");
    else if (method === "GET")
      expect(result.body.response.sessions).toEqual([]);
    else expect(result.body.errors[0].code).toBe("form_identifier_not_found");
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`sign-in matches Paddock and displays validation at ${viewport.width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto("/admin");
    const email = page.getByRole("textbox", {
      name: "Email address",
      exact: true,
    });
    await expect(email).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

    const card = page.locator(".cl-card");
    const button = page.getByRole("button", { name: "Continue", exact: true });
    await expect(card).toHaveCSS("background-color", "rgb(23, 26, 24)");
    await expect(email).toHaveCSS("background-color", "rgb(16, 17, 17)");
    await expect(email).toHaveCSS("color", "rgb(237, 236, 231)");
    await expect(button).toHaveCSS("background-color", "rgb(244, 85, 64)");
    await expect(page.locator(".cl-headerTitle")).toHaveCSS(
      "font-size",
      "22px",
    );
    await expect(page.locator(".cl-headerTitle")).toHaveCSS(
      "font-family",
      '"Space Grotesk", sans-serif',
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const main = await page.locator("main").boundingBox();
    const form = await page.locator(".cl-cardBox").boundingBox();
    expect(form!.x).toBeGreaterThanOrEqual(main!.x);
    expect(form!.x + form!.width).toBeLessThanOrEqual(main!.x + main!.width);
    await expect(
      page.getByRole("link", { name: "Back to collection" }),
    ).toHaveAttribute("href", "/");
    await page.screenshot({
      path: `.local/login-theme/sign-in-${viewport.width}.png`,
      fullPage: true,
      animations: "disabled",
    });

    await email.fill("unknown@example.invalid");
    await button.click();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#error-identifier")).toHaveText(
      "Couldn't find your account.",
    );
    await expect(page.locator("#error-identifier")).toBeVisible();
    await expect(email).toBeVisible();
    await expect(button).toBeEnabled();
    await page.screenshot({
      path: `.local/login-theme/sign-in-error-${viewport.width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
}
