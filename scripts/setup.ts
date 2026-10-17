import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.ts";

const manifest = JSON.parse(await readFile("assets/artwork.json", "utf8")) as {
  fonts: Record<string, { sourceUrl: string }>;
};
await mkdir(path.join(config.dataDir, "fonts"), { recursive: true });
for (const [face, font] of Object.entries(manifest.fonts)) {
  const file = path.join(config.dataDir, "fonts", `${face}.woff2`);
  try {
    await access(file);
  } catch {
    const response = await fetch(font.sourceUrl, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `Unable to download official ${face} font (${response.status}).`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== "wOF2")
      throw new Error("Official font download was not a WOFF2 font.");
    await writeFile(file, bytes);
    console.log(`Prepared ${face} font.`);
  }
}
console.log("Artwork and font setup complete.");
