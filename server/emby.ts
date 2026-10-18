import type {
  EmbyCandidate,
  EmbyShow,
  RaceEvent,
  SessionKey,
} from "../shared/types.ts";
import { sessionKeys } from "../shared/types.ts";
import { Artwork } from "./artwork.ts";
import { Store } from "./db.ts";

interface EmbyItem {
  Id: string;
  Name: string;
  Path?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  ProductionYear?: number;
}
const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const aliases: Record<string, string[]> = {
  melbourne: ["australia", "australian", "melbourne", "albert park"],
  shanghai: ["china", "chinese", "shanghai"],
  suzuka: ["japan", "japanese", "suzuka"],
  sakhir: ["bahrain", "sakhir"],
  sepang: ["bahrain", "malaysia", "sepang"],
  jeddah: ["saudi", "jeddah"],
  montreal: ["canada", "canadian", "montreal"],
  spielberg: ["austria", "austrian", "spielberg"],
  silverstone: ["britain", "british", "silverstone"],
  spa: ["belgium", "belgian", "spa"],
  hungaroring: ["hungary", "hungarian", "hungaroring"],
  zandvoort: ["dutch", "netherlands", "zandvoort"],
  monza: ["italian", "italy", "monza"],
  barcelona: ["barcelona", "catalunya", "catalonia"],
  madrid: ["spanish", "madrid", "madring", "spain"],
  "marina-bay": ["singapore"],
  austin: ["united states", "austin", "cota"],
  "mexico-city": ["mexico", "mexican"],
  interlagos: ["brazil", "brazilian", "sao paulo", "interlagos"],
  lusail: ["qatar", "lusail", "losail"],
  "yas-marina": ["abu dhabi", "yas marina"],
};
const excludedSessions =
  /\b(practice|fp ?[123]|highlights|notebook|preview|review)\b/;
export function inferSession(text: string): SessionKey | null {
  const name = normalize(text);
  if (excludedSessions.test(name)) return null;
  if (
    (/\bsprint\b/.test(name) &&
      /\b(qualifying|qualification|quali|qual|shootout)\b/.test(name)) ||
    /\bsq\b/.test(name)
  )
    return "sprint-qualifying";
  if (/\bsprint\b/.test(name)) return "sprint";
  if (/\b(qualifying|qualification|quali|qual)\b/.test(name))
    return "qualifying";
  if (/\b(race|grand prix)\b/.test(name)) return "race";
  return null;
}
export function matchItem(item: EmbyItem, events: RaceEvent[]): EmbyCandidate {
  // Read the file and its nearest folders first, before a show's debut year.
  const pathParts = (item.Path || "").split(/[\\/]/).filter(Boolean).reverse();
  const parts = [item.Name, ...pathParts];
  const text = normalize(parts.join(" "));
  const extractedYear = parts
    .map((part) => /(?<!\d)(20\d{2})(?!\d)/.exec(part)?.[1])
    .find(Boolean);
  const year = extractedYear
    ? Number(extractedYear)
    : item.ParentIndexNumber && item.ParentIndexNumber >= 1950
      ? item.ParentIndexNumber
      : item.ProductionYear;
  // Only session folders next to the file can exclude an episode. Stop at
  // the first venue, season, show or other directory so storage paths such
  // as /srv/review never suppress an otherwise valid match.
  const episodeParts = [item.Name, pathParts[0] || ""];
  for (const folder of pathParts.slice(1)) {
    if (!inferSession(folder) && !excludedSessions.test(normalize(folder)))
      break;
    episodeParts.push(folder);
  }
  const excluded = episodeParts.some((part) =>
    excludedSessions.test(normalize(part)),
  );
  // "Grand Prix" alone names the weekend; an explicit session in a file or
  // folder is stronger evidence than that generic episode title.
  const explicitSessions = parts.map((part) =>
    inferSession(normalize(part).replace(/\bgrand prix\b/g, "")),
  );
  const session = excluded
    ? null
    : explicitSessions.find(Boolean) || parts.map(inferSession).find(Boolean);
  const candidates = session
    ? events
        .filter(
          (event) =>
            !event.cancelled &&
            (!year || event.season === year) &&
            sessionKeys(event.sprint).includes(session),
        )
        .flatMap((event) => {
          const names = [
            ...(aliases[event.venueKey] || []),
            event.slug.replaceAll("-", " "),
          ];
          if (event.venueKey === "barcelona" && event.season <= 2025)
            names.push("spanish", "spain");
          const matched = names.some((alias) =>
            ` ${text} `.includes(` ${alias} `),
          );
          return matched
            ? [{ eventId: event.id, session, score: year ? 100 : 70 }]
            : [];
        })
        .sort((a, b) => b.score - a.score)
    : [];
  return {
    itemId: item.Id,
    name: item.Name,
    path: item.Path,
    year,
    candidates,
  };
}
export class Emby {
  constructor(
    private store: Store,
    private artwork: Artwork,
    private baseUrl: string,
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  get configured() {
    return Boolean(this.baseUrl && this.key);
  }
  private async request(route: string, init?: RequestInit): Promise<Response> {
    if (!this.configured)
      throw new Error("Configure EMBY_URL and EMBY_API_KEY on Herman first.");
    const response = await this.fetcher(`${this.baseUrl}${route}`, {
      ...init,
      headers: { "X-Emby-Token": this.key, ...init?.headers },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw Object.assign(
        new Error(
          `Emby returned ${response.status}. Check the server connection and API permissions.`,
        ),
        { status: response.status },
      );
    return response;
  }
  async libraries() {
    let response: Response;
    try {
      response = await this.request("/Library/VirtualFolders/Query");
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      response = await this.request("/Library/VirtualFolders");
    }
    const data = (await response.json()) as {
      Items?: {
        Name: string;
        ItemId?: string;
        Id?: string;
        CollectionType?: string;
      }[];
    };
    const items = Array.isArray(data) ? data : data.Items;
    if (!Array.isArray(items))
      throw new Error("Emby returned an invalid library response.");
    return items
      .map((item) => ({
        id: item.ItemId || item.Id,
        name: item.Name,
        type: item.CollectionType,
      }))
      .filter((item) => item.id);
  }
  async shows(libraryId: string): Promise<EmbyShow[]> {
    const items = await this.items(libraryId, "Series");
    return items.map((item) => ({
      id: item.Id,
      name: item.Name,
      path: item.Path,
    }));
  }
  async candidates(): Promise<EmbyCandidate[]> {
    const { embyLibraryId, embySeriesId } = await this.store.settings();
    if (!embyLibraryId)
      throw new Error("Choose your F1 library before inspecting episodes.");
    if (
      embySeriesId &&
      !(await this.shows(embyLibraryId)).some(
        (show) => show.id === embySeriesId,
      )
    )
      throw new Error(
        "The selected TV show is no longer in this library. Load the shows and choose again.",
      );
    const items = await this.items(embySeriesId || embyLibraryId, "Episode");
    const events = await this.store.events();
    return items.map((item) => matchItem(item, events));
  }
  private async items(
    parentId: string,
    type: "Series" | "Episode",
  ): Promise<EmbyItem[]> {
    const items: EmbyItem[] = [];
    for (let start = 0; start < 10000; start += 200) {
      const params = new URLSearchParams({
        ParentId: parentId,
        Recursive: "true",
        IncludeItemTypes: type,
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: "Path,ParentId",
        StartIndex: String(start),
        Limit: "200",
      });
      const data = (await (await this.request(`/Items?${params}`)).json()) as {
        Items?: EmbyItem[];
        TotalRecordCount?: number;
      };
      if (!Array.isArray(data.Items))
        throw new Error(
          `Emby returned an invalid ${type === "Series" ? "TV show" : "episode"} response.`,
        );
      items.push(...data.Items);
      if (
        data.Items.length < 200 ||
        items.length >= (data.TotalRecordCount ?? Infinity)
      )
        break;
    }
    return items;
  }
  async sync(): Promise<string> {
    if (!this.configured) return "Emby is not connected yet.";
    let updated = 0;
    let failed = 0;
    const index = await this.store.backgrounds();
    for (const mapping of await this.store.mappings()) {
      const event = await this.store.event(mapping.eventId);
      if (
        !event ||
        event.cancelled ||
        !sessionKeys(event.sprint).includes(mapping.session) ||
        !(await this.artwork.background(event, index))
      )
        continue;
      const version = await this.artwork.version(event, mapping.session, index);
      if (mapping.lastImageVersion === version) continue;
      try {
        const bytes = await this.artwork.png(event, mapping.session, 3840);
        await this.request(
          `/Items/${encodeURIComponent(mapping.itemId)}/Images/Primary`,
          {
            method: "POST",
            headers: { "Content-Type": "image/png" },
            body: bytes.toString("base64"),
          },
        );
        await this.store.saveMapping({
          ...mapping,
          lastImageVersion: version,
          lastSyncedAt: new Date().toISOString(),
          error: null,
        });
        updated++;
      } catch (error) {
        await this.store.saveMapping({
          ...mapping,
          error:
            error instanceof Error
              ? error.message
              : "Emby artwork update failed.",
        });
        failed++;
      }
    }
    return `${updated} Emby images updated${failed ? ` · ${failed} failed (see mappings)` : ""}.`;
  }
}
