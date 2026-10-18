import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as fontkit from "fontkit";
import type { RaceEvent, SessionKey, LibraryEvent } from "../shared/types.ts";
import { sessions, sessionKeys } from "../shared/types.ts";
import { Store } from "./db.ts";

interface TextStyle {
  text?: string;
  fontSize: number;
  fill: string;
  baselineY: number;
  centerX?: number;
  rightX?: number;
}
interface VenueArtwork {
  venueKey: string;
  backgroundKey: string | null;
  displayName: string;
  title: TextStyle;
  session: TextStyle;
  round: TextStyle;
  missingBackground?: boolean;
}
interface Manifest {
  fonts: Record<"wide" | "bold", { family: string; sourceUrl: string }>;
  backgrounds: Record<
    string,
    { file: string; width: number; height: number; sha256?: string }
  >;
  seasons: Record<string, Record<string, VenueArtwork>>;
  logo: { file: string; x: number; y: number; width: number; height: number };
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );

export class Artwork {
  manifest: Manifest;
  fonts: Record<"wide" | "bold", fontkit.Font>;
  logo: string;
  pending = new Map<string, Promise<Buffer>>();
  constructor(
    public store: Store,
    public root: string,
    public dataDir: string,
  ) {
    this.manifest = JSON.parse(
      readFileSync(path.join(root, "assets/artwork.json"), "utf8"),
    );
    this.fonts = {
      wide: fontkit.openSync(
        path.join(dataDir, "fonts/wide.woff2"),
      ) as fontkit.Font,
      bold: fontkit.openSync(
        path.join(dataDir, "fonts/bold.woff2"),
      ) as fontkit.Font,
    };
    this.logo = readFileSync(path.join(root, this.manifest.logo.file)).toString(
      "base64",
    );
    mkdirSync(path.join(dataDir, "renders"), { recursive: true });
  }
  style(event: RaceEvent): VenueArtwork {
    const exact = this.manifest.seasons[String(event.season)]?.[event.venueKey];
    const prior = Object.values(this.manifest.seasons)
      .reverse()
      .map((season) => season[event.venueKey])
      .find(Boolean);
    if (exact || prior) return exact || prior;
    return {
      venueKey: event.venueKey,
      backgroundKey: null,
      displayName: event.locality || event.country,
      title: {
        text: (event.locality || event.country).toUpperCase(),
        fontSize: 82,
        fill: "#faedde",
        baselineY: 159.894,
      },
      session: { fontSize: 72, fill: "#faedde", baselineY: 283.206 },
      round: { fontSize: 60, fill: "#faedde", baselineY: 1024, rightX: 1870 },
    };
  }
  // Pass one index when rendering a list to avoid a query per weekend.
  async background(
    event: RaceEvent,
    index?: Map<string, { file: string; version: string }>,
  ): Promise<{ file: string; version: string } | null> {
    const generated = await this.store.latestBackground(
      event.venueKey,
      event.season,
      index,
    );
    if (generated && existsSync(generated.file)) return generated;
    const key = this.style(event).backgroundKey;
    const source = key && this.manifest.backgrounds[key];
    return source
      ? {
          file: path.join(this.root, source.file),
          version: source.sha256 || key!,
        }
      : null;
  }
  async version(
    event: RaceEvent,
    session?: SessionKey,
    index?: Map<string, { file: string; version: string }>,
  ) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          renderer: 4,
          season: event.season,
          round: event.round,
          venue: event.venueKey,
          session,
          style: this.style(event),
          background: (await this.background(event, index))?.version,
        }),
      )
      .digest("hex")
      .slice(0, 20);
  }
  async libraryEvents(events: RaceEvent[]): Promise<LibraryEvent[]> {
    const index = await this.store.backgrounds();
    return Promise.all(events.map((event) => this.libraryEvent(event, index)));
  }
  async libraryEvent(
    event: RaceEvent,
    index?: Map<string, { file: string; version: string }>,
  ): Promise<LibraryEvent> {
    index ??= await this.store.backgrounds();
    const background = await this.background(event, index);
    const versions = await Promise.all(
      sessionKeys(event.sprint).map((session) =>
        this.version(event, session, index),
      ),
    );
    return {
      ...event,
      displayName: this.style(event).displayName,
      backgroundReady: Boolean(background),
      backgroundVersion: background?.version || null,
      images: sessionKeys(event.sprint).map((session, position) => {
        const base = `/images/${event.season}/${event.slug}/${session}`;
        const version = versions[position];
        return {
          session,
          label: sessions[session],
          thumbnail: `${base}.png?width=640&v=${version}`,
          png: `${base}.png?v=${version}`,
          svg: `${base}.svg?v=${version}`,
        };
      }),
    };
  }
  text(
    text: string,
    style: TextStyle,
    face: "wide" | "bold",
    alignment: "center" | "right",
  ) {
    const font = this.fonts[face];
    const run = font.layout(text);
    const nominalScale = style.fontSize / font.unitsPerEm;
    const advance = run.positions.reduce(
      (sum, position) => sum + position.xAdvance,
      0,
    );
    const scale = Math.min(nominalScale, 1680 / Math.max(advance, 1));
    let x =
      alignment === "center"
        ? (style.centerX ?? 960) - (advance * scale) / 2
        : (style.rightX ?? 1870) - advance * scale;
    return run.glyphs
      .map((glyph, index) => {
        const position = run.positions[index];
        const transform = `translate(${x + position.xOffset * scale} ${style.baselineY - position.yOffset * scale}) scale(${scale} ${-scale})`;
        x += position.xAdvance * scale;
        return `<path fill="${escape(style.fill)}" transform="${transform}" d="${glyph.path.toSVG()}"/>`;
      })
      .join("");
  }
  async svg(event: RaceEvent, session: SessionKey) {
    const background = await this.background(event);
    const scene = background
      ? `<image width="1920" height="1080" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${(await readFile(background.file)).toString("base64")}"/>`
      : `<rect width="1920" height="1080" fill="#172322"/><path d="M-200 1080 700 350h800l-900 730z" fill="#223331"/><path d="M-50 1080 850 350h70l-900 730z" fill="#f14936"/><text x="960" y="630" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#b5c1ba">Venue illustration pending</text>`;
    return this.document(event, session, scene);
  }
  private document(event: RaceEvent, session: SessionKey, scene: string) {
    const style = this.style(event);
    const logo = this.manifest.logo;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><title>${escape(`${event.season} ${event.name} — ${sessions[session]}`)}</title>${scene}<image x="${logo.x}" y="${logo.y}" width="${logo.width}" height="${logo.height}" href="data:image/svg+xml;base64,${this.logo}"/>${this.text(style.title.text || style.displayName.toUpperCase(), style.title, "wide", "center")}${this.text(sessions[session].toUpperCase(), style.session, "bold", "center")}${this.text(`${event.season} Round ${event.round}`, style.round, "bold", "right")}</svg>`;
  }
  async png(
    event: RaceEvent,
    session: SessionKey,
    width = 3840,
  ): Promise<Buffer> {
    const cacheKey = `${await this.version(event, session)}-${width}`;
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;
    const file = path.join(this.dataDir, "renders", `${cacheKey}.png`);
    const render = (async () => {
      if (existsSync(file)) return readFile(file);
      const background = await this.background(event);
      // Keep large raster data out of the SVG parser: base64 image attributes
      // can exceed libxml's buffer limit even for valid provider output.
      const svg = background
        ? this.document(event, session, "")
        : await this.svg(event, session);
      const overlay = await sharp(Buffer.from(svg), {
        density: (72 * width) / 1920,
        limitInputPixels: 40_000_000,
      })
        .png({ compressionLevel: 6 })
        .toBuffer();
      const image = background
        ? await sharp(background.file, { limitInputPixels: 40_000_000 })
            .resize(width, (width * 1080) / 1920, { fit: "cover" })
            .composite([{ input: overlay }])
            .png({ compressionLevel: 6 })
            .toBuffer()
        : overlay;
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, image);
      await rename(temporary, file);
      return image;
    })();
    this.pending.set(cacheKey, render);
    try {
      return await render;
    } finally {
      this.pending.delete(cacheKey);
    }
  }
}
