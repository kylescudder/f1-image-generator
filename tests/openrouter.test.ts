import { test, expect } from "bun:test";
import { OpenRouter } from "../server/openrouter.ts";
import type { Store } from "../server/db.ts";
import { owner } from "../server/api.ts";
import { useServices, type Services } from "../server/services.ts";
import { guardOverrides } from "../server/guard.ts";

const spending = {
  usage: 12.3456,
  usage_daily: 0,
  usage_weekly: 1.25,
  usage_monthly: 3.5,
  byok_usage: 2,
  label: "private-key-label",
};
const router = (fetcher: typeof fetch, key = "fixture-key") =>
  new OpenRouter({} as Store, key, "https://paddock.test", fetcher);

test("spending reads the current key directly and returns only usage fields", async () => {
  let calls = 0;
  const client = router((async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    calls++;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/key");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer fixture-key",
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ data: spending });
  }) as unknown as typeof fetch);
  const result = await client.usage();
  expect(result).toEqual({
    total: 12.3456,
    daily: 0,
    weekly: 1.25,
    monthly: 3.5,
    byokTotal: 2,
    fetchedAt: expect.any(String),
  });
  expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
  await client.usage();
  expect(calls).toBe(2);
});

test("unconfigured and failed spending never become a zero-dollar success", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json(
      { error: { message: "private-provider-details" } },
      { status: 401 },
    );
  }) as unknown as typeof fetch;
  await expect(router(fetcher, "").usage()).rejects.toThrow(
    "Configure OPENROUTER_API_KEY",
  );
  expect(calls).toBe(0);
  await expect(router(fetcher).usage()).rejects.toThrow("unavailable (401)");
  for (const data of [
    null,
    {},
    { ...spending, usage: "12.34" },
    { ...spending, usage_daily: -1 },
  ]) {
    await expect(
      router((async () =>
        Response.json({ data })) as unknown as typeof fetch).usage(),
    ).rejects.toThrow("invalid spending data");
  }
  await expect(
    router((async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof fetch).usage(),
  ).rejects.toThrow("network unavailable");
});

test("spending is private, uncached and does not expose key metadata", async () => {
  let calls = 0;
  useServices({
    router: router((async () => {
      calls++;
      return Response.json({ data: spending });
    }) as unknown as typeof fetch),
  } as Services);
  const request = new Request("https://paddock.test/api/admin/usage");
  try {
    guardOverrides.current = {
      identity: () => ({ userId: null, isAuthenticated: false }),
    };
    expect((await owner.usage({ request })).status).toBe(401);
    expect(calls).toBe(0);
    guardOverrides.current = {
      identity: () => ({ userId: "test-owner", isAuthenticated: true }),
    };
    const response = await owner.usage({ request });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain('"total":12.3456');
    expect(body).not.toContain("private-key-label");
    expect(body).not.toContain("fixture-key");
    expect(calls).toBe(1);
  } finally {
    guardOverrides.current = undefined;
    useServices(undefined);
  }
});
