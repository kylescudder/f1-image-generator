import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as fontkit from "fontkit";
import type {
  Glyph,
  LibraryEvent,
  OverlayColours,
  OverlayElement,
  RaceEvent,
  SessionKey,
  StudioState,
} from "../shared/types.ts";
import {
  overlayElements,
  resolveColour,
  sessions,
  sessionKeys,
} from "../shared/types.ts";
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
  logo: {
    file: string;
    fill: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
type Overlays = Map<string, OverlayColours>;
const venueSeason = (event: RaceEvent) => `${event.venueKey}:${event.season}`;
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
  logoSvg: string;
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
    this.logoSvg = readFileSync(
      path.join(root, this.manifest.logo.file),
      "utf8",
    );
    this.logo = Buffer.from(this.logoSvg).toString("base64");
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
  defaultColours(event: RaceEvent): OverlayColours {
    const style = this.style(event);
    const fills: Record<OverlayElement, string> = {
      logo: this.manifest.logo.fill,
      title: style.title.fill,
      session: style.session.fill,
      round: style.round.fill,
    };
    return Object.fromEntries(
      Object.keys(overlayElements).map((element) => [
        element,
        {
          linked: true,
          colour: fills[element as OverlayElement].toLowerCase(),
          sessions: {},
        },
      ]),
    ) as OverlayColours;
  }
  // Approved colour overrides for this exact venue and season, if any.
  async overrides(event: RaceEvent, overlays?: Overlays) {
    return overlays
      ? overlays.get(venueSeason(event))
      : this.store.overlay(venueSeason(event));
  }
  async colours(event: RaceEvent, overlays?: Overlays) {
    return (
      (await this.overrides(event, overlays)) ?? this.defaultColours(event)
    );
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
    overlays?: Overlays,
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
          // Omitted when unset so weekends without overrides keep their version.
          colours: await this.overrides(event, overlays),
        }),
      )
      .digest("hex")
      .slice(0, 20);
  }
  async libraryEvents(events: RaceEvent[]): Promise<LibraryEvent[]> {
    const index = await this.store.backgrounds();
    const overlays = await this.store.overlays();
    return Promise.all(
      events.map((event) => this.libraryEvent(event, index, overlays)),
    );
  }
  async libraryEvent(
    event: RaceEvent,
    index?: Map<string, { file: string; version: string }>,
    overlays?: Overlays,
  ): Promise<LibraryEvent> {
    index ??= await this.store.backgrounds();
    overlays ??= await this.store.overlays();
    const background = await this.background(event, index);
    const versions = await Promise.all(
      sessionKeys(event.sprint).map((session) =>
        this.version(event, session, index, overlays),
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
  glyphs(
    text: string,
    style: TextStyle,
    face: "wide" | "bold",
    alignment: "center" | "right",
  ): Glyph[] {
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
    return run.glyphs.map((glyph, index) => {
      const position = run.positions[index];
      const transform = `translate(${x + position.xOffset * scale} ${style.baselineY - position.yOffset * scale}) scale(${scale} ${-scale})`;
      x += position.xAdvance * scale;
      return { d: glyph.path.toSVG(), transform };
    });
  }
  private paths(glyphs: Glyph[], fill: string) {
    return glyphs
      .map(
        (glyph) =>
          `<path fill="${escape(fill)}" transform="${glyph.transform}" d="${glyph.d}"/>`,
      )
      .join("");
  }
  private titleGlyphs(event: RaceEvent) {
    const style = this.style(event);
    return this.glyphs(
      style.title.text || style.displayName.toUpperCase(),
      style.title,
      "wide",
      "center",
    );
  }
  private sessionGlyphs(event: RaceEvent, session: SessionKey) {
    return this.glyphs(
      sessions[session].toUpperCase(),
      this.style(event).session,
      "bold",
      "center",
    );
  }
  private roundGlyphs(event: RaceEvent) {
    return this.glyphs(
      `${event.season} Round ${event.round}`,
      this.style(event).round,
      "bold",
      "right",
    );
  }
  // The logo has a single fill, so recolouring rewrites its fill attributes.
  recolourLogo(fill: string) {
    return this.logoSvg.replace(/fill="[^"]*"/g, `fill="${escape(fill)}"`);
  }
  // Vector overlay geometry, so the studio preview matches the renderer exactly.
  studioOverlay(event: RaceEvent): StudioState["overlay"] {
    return {
      logo: { ...this.manifest.logo, svg: this.logoSvg },
      title: this.titleGlyphs(event),
      round: this.roundGlyphs(event),
      sessions: Object.fromEntries(
        sessionKeys(event.sprint).map((session) => [
          session,
          this.sessionGlyphs(event, session),
        ]),
      ),
    };
  }
  async svg(event: RaceEvent, session: SessionKey) {
    const background = await this.background(event);
    const scene = background
      ? `<image width="1920" height="1080" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${(await readFile(background.file)).toString("base64")}"/>`
      : `<rect width="1920" height="1080" fill="#172322"/><path d="M-200 1080 700 350h800l-900 730z" fill="#223331"/><path d="M-50 1080 850 350h70l-900 730z" fill="#f14936"/><text x="960" y="630" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#b5c1ba">Venue illustration pending</text>`;
    return this.document(event, session, scene, await this.colours(event));
  }
  private document(
    event: RaceEvent,
    session: SessionKey,
    scene: string,
    colours: OverlayColours,
  ) {
    const logo = this.manifest.logo;
    const fill = (element: OverlayElement) =>
      resolveColour(colours, element, session);
    const logoFill = fill("logo");
    const logoData =
      logoFill === logo.fill.toLowerCase()
        ? this.logo
        : Buffer.from(this.recolourLogo(logoFill)).toString("base64");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><title>${escape(`${event.season} ${event.name} — ${sessions[session]}`)}</title>${scene}<image x="${logo.x}" y="${logo.y}" width="${logo.width}" height="${logo.height}" href="data:image/svg+xml;base64,${logoData}"/>${this.paths(this.titleGlyphs(event), fill("title"))}${this.paths(this.sessionGlyphs(event, session), fill("session"))}${this.paths(this.roundGlyphs(event), fill("round"))}</svg>`;
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
        ? this.document(event, session, "", await this.colours(event))
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
