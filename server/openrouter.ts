import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type {
  Capability,
  ImageModel,
  OpenRouterUsage,
} from "../shared/types.ts";
import { Store } from "./db.ts";

const base = "https://openrouter.ai/api/v1";
const usageSchema = z.object({
  data: z.object({
    usage: z.number().nonnegative(),
    usage_daily: z.number().nonnegative(),
    usage_weekly: z.number().nonnegative(),
    usage_monthly: z.number().nonnegative(),
    byok_usage: z.number().nonnegative().nullish(),
  }),
});
type RawModel = {
  id?: string;
  name?: string;
  created?: number;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, Capability> | string[];
};
export function normalizeModels(
  imageData: unknown[],
  generalData: unknown[],
): ImageModel[] {
  const models = new Map<string, ImageModel>();
  for (const [route, data] of [
    ["chat", generalData],
    ["images", imageData],
  ] as const)
    for (const entry of data) {
      const raw = entry as RawModel;
      if (
        !raw.id ||
        !raw.name ||
        !raw.architecture?.output_modalities?.includes("image")
      )
        continue;
      models.set(raw.id, {
        id: raw.id,
        name: raw.name,
        created: raw.created,
        description: raw.description,
        inputModalities: raw.architecture.input_modalities || ["text"],
        outputModalities: raw.architecture.output_modalities,
        parameters: !Array.isArray(raw.supported_parameters)
          ? raw.supported_parameters || {}
          : {},
        route,
      });
    }
  return [...models.values()].sort(
    (a, b) =>
      (b.created || 0) - (a.created || 0) || a.name.localeCompare(b.name),
  );
}
export function imageRequest(
  model: ImageModel,
  prompt: string,
  reference: string | null,
  resolution: string,
  quality: string,
) {
  if (model.route === "chat")
    return {
      model: model.id,
      modalities: model.outputModalities.filter(
        (value) => value === "image" || value === "text",
      ),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...(reference && model.inputModalities.includes("image")
              ? [{ type: "image_url", image_url: { url: reference } }]
              : []),
          ],
        },
      ],
    };
  const body: Record<string, unknown> = { model: model.id, prompt };
  const put = (
    key: string,
    desired: string | number,
    fallbacks: (string | number)[] = [],
  ) => {
    const descriptor = model.parameters[key];
    if (!descriptor) return;
    if (descriptor.type === "enum") {
      const value = [desired, ...fallbacks].find((value) =>
        descriptor.values?.includes(value),
      );
      if (value !== undefined) body[key] = value;
    } else if (
      descriptor.type === "range" &&
      typeof desired === "number" &&
      desired >= (descriptor.min ?? -Infinity) &&
      desired <= (descriptor.max ?? Infinity)
    )
      body[key] = desired;
  };
  put("aspect_ratio", "16:9");
  put("resolution", resolution, ["2K", "1K"]);
  put("quality", quality, ["high", "medium", "standard", "auto"]);
  put("output_format", "png", ["webp", "jpeg"]);
  put("n", 1);
  const references = model.parameters.input_references;
  if (
    reference &&
    model.inputModalities.includes("image") &&
    references &&
    (references.max ?? 1) >= 1
  )
    body.input_references = [
      { type: "image_url", image_url: { url: reference } },
    ];
  return body;
}
async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Provider image exceeds the 32 MB limit.");
  if (!response.body) throw new Error("Provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function privateAddress(address: string) {
  if (address.includes(":"))
    return (
      address === "::1" ||
      address === "::" ||
      /^(fc|fd|fe[89ab])/i.test(address) ||
      address.includes("ffff:")
    );
  const parts = address.split(".").map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
}
export async function readImageUrl(
  source: string,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  if (source.startsWith("data:")) {
    const match =
      /^data:image\/(png|jpeg|webp|svg\+xml);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(
        source,
      );
    if (!match || match[2].length > 44_800_000)
      throw new Error("Provider returned an unsupported image.");
    return Buffer.from(match[2], "base64");
  }
  let current = source;
  for (let hop = 0; hop < 4; hop++) {
    const url = new URL(current);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname.replace(/[\[\]]/g, "")) ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".local")
    )
      throw new Error("Provider image URL is not a public HTTPS URL.");
    const addresses = await lookup(url.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((record) => privateAddress(record.address))
    )
      throw new Error("Provider image URL resolves to a private network.");
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new Error("Invalid provider redirect.");
      current = new URL(next, url).href;
      continue;
    }
    if (!response.ok)
      throw new Error(`Image download failed (${response.status}).`);
    return readLimited(response, 32 * 1024 * 1024);
  }
  throw new Error("Too many image redirects.");
}
export function assertSafeImage(bytes: Buffer) {
  const text = bytes.subarray(0, 1000).toString("utf8");
  if (!text.includes("<svg") && !text.includes("<?xml")) return;
  const svg = bytes.toString("utf8");
  if (/<!|<script|<foreignObject|@import/i.test(svg))
    throw new Error("Provider SVG contains unsupported active content.");
  for (const match of svg.matchAll(
    /(?:href|src)\s*=\s*["']([^"']*)["']|url\(\s*["']?([^)'"\s]+)/gi,
  )) {
    const target = match[1] || match[2];
    if (!target.startsWith("#") && !target.startsWith("data:image/"))
      throw new Error("Provider SVG has external references.");
  }
}

export class OpenRouter {
  constructor(
    public store: Store,
    private key: string,
    private appUrl: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private headers() {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.appUrl,
      "X-OpenRouter-Title": "Paddock F1 Artwork",
    };
  }
  async usage(): Promise<OpenRouterUsage> {
    if (!this.key)
      throw new Error("Configure OPENROUTER_API_KEY to view spending.");
    const response = await this.fetcher(`${base}/key`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `OpenRouter spending is unavailable (${response.status}).`,
      );
    const result = usageSchema.safeParse(await response.json());
    if (!result.success)
      throw new Error("OpenRouter returned invalid spending data.");
    const { data } = result.data;
    return {
      total: data.usage,
      daily: data.usage_daily,
      weekly: data.usage_weekly,
      monthly: data.usage_monthly,
      byokTotal: data.byok_usage ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }
  async models(
    force = false,
  ): Promise<{ models: ImageModel[]; fetchedAt: string; stale: boolean }> {
    const cache = await this.store.get<{
      models: ImageModel[];
      fetchedAt: string;
    } | null>("modelCatalog", null);
    if (!force && cache && Date.now() - Date.parse(cache.fetchedAt) < 3600000)
      return { ...cache, stale: false };
    try {
      const read = async (endpoint: string) => {
        const response = await this.fetcher(`${base}/${endpoint}`, {
          headers: this.key ? this.headers() : { Accept: "application/json" },
          signal: AbortSignal.timeout(25000),
        });
        if (!response.ok)
          throw new Error(
            `OpenRouter model catalogue returned ${response.status}.`,
          );
        const body = (await response.json()) as { data?: unknown[] };
        if (!Array.isArray(body.data))
          throw new Error("OpenRouter returned an invalid catalogue.");
        return body.data;
      };
      const [images, general] = await Promise.allSettled([
        read("images/models"),
        read("models?output_modalities=image&sort=newest"),
      ]);
      // Never hide newly released image-only models behind a failed primary catalogue.
      if (images.status === "rejected") throw images.reason;
      const models = normalizeModels(
        images.value,
        general.status === "fulfilled" ? general.value : [],
      );
      if (!models.length)
        throw new Error("OpenRouter returned no image-generation models.");
      const result = { models, fetchedAt: new Date().toISOString() };
      await this.store.set("modelCatalog", result);
      return { ...result, stale: false };
    } catch (error) {
      if (cache && !force) return { ...cache, stale: true };
      throw error;
    }
  }
  async generate(
    model: ImageModel,
    prompt: string,
    reference: string | null,
    resolution: string,
    quality: string,
  ) {
    if (!this.key)
      throw new Error(
        "Configure OPENROUTER_API_KEY on Herman before generating backgrounds.",
      );
    let selected = model;
    let provider: Record<string, unknown> | undefined;
    if (model.route === "images") {
      const response = await this.fetcher(
        `${base}/images/models/${model.id.split("/").map(encodeURIComponent).join("/")}/endpoints`,
        { headers: this.headers(), signal: AbortSignal.timeout(25000) },
      );
      if (!response.ok)
        throw new Error(
          `Unable to check this model's provider capabilities (${response.status}). No paid request was made.`,
        );
      const info = (await response.json()) as {
        endpoints?: {
          provider_tag?: string;
          supported_parameters?: Record<string, Capability>;
        }[];
      };
      const endpoints = info.endpoints?.filter(
        (endpoint) => endpoint.provider_tag && endpoint.supported_parameters,
      );
      if (!endpoints?.length)
        throw new Error(
          "This model has no available image provider. Refresh the catalogue and choose another.",
        );
      const ranked = endpoints
        .map((endpoint) => ({
          endpoint,
          score:
            (endpoint.supported_parameters!.aspect_ratio?.values?.includes(
              "16:9",
            )
              ? 8
              : 0) +
            (endpoint.supported_parameters!.resolution?.values?.includes(
              resolution,
            )
              ? 4
              : 0) +
            (endpoint.supported_parameters!.quality?.values?.includes(quality)
              ? 2
              : 0) +
            (reference && endpoint.supported_parameters!.input_references
              ? 1
              : 0),
        }))
        .sort((a, b) => b.score - a.score);
      selected = {
        ...model,
        parameters: ranked[0].endpoint.supported_parameters!,
      };
      provider = {
        only: [ranked[0].endpoint.provider_tag],
        allow_fallbacks: false,
      };
    }
    const response = await this.fetcher(
      `${base}/${model.route === "images" ? "images" : "chat/completions"}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          ...imageRequest(selected, prompt, reference, resolution, quality),
          ...(provider ? { provider } : {}),
        }),
        signal: AbortSignal.timeout(300000),
      },
    );
    const data = JSON.parse(
      (await readLimited(response, 48 * 1024 * 1024)).toString(),
    ) as {
      error?: { message?: string };
      data?: { b64_json?: string; url?: string; media_type?: string }[];
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      usage?: { cost?: number };
    };
    if (!response.ok || data.error) {
      const reason =
        data.error?.message || `OpenRouter returned ${response.status}.`;
      throw new Error(
        response.status === 429
          ? `${reason} Retry after the provider limit resets; no automatic paid retry was made.`
          : reason,
      );
    }
    const first = data.data?.[0];
    const bytes = first?.b64_json
      ? await readImageUrl(
          `data:${first.media_type || "image/png"};base64,${first.b64_json}`,
        )
      : await readImageUrl(
          first?.url ||
            data.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
            "",
          this.fetcher,
        );
    assertSafeImage(bytes);
    return { bytes, cost: data.usage?.cost };
  }
}
