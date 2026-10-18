export const sessions = {
  "sprint-qualifying": "Sprint Qualifying",
  sprint: "Sprint Race",
  qualifying: "Race Qualifying",
  race: "Race",
} as const;
export type SessionKey = keyof typeof sessions;
export const sessionKeys = (sprint: boolean): SessionKey[] =>
  sprint
    ? ["sprint-qualifying", "sprint", "qualifying", "race"]
    : ["qualifying", "race"];

export interface RaceEvent {
  id: string;
  slug: string;
  season: number;
  round: number;
  name: string;
  circuit: string;
  circuitId: string;
  venueKey: string;
  country: string;
  locality: string;
  date: string;
  startDate: string;
  sprint: boolean;
  cancelled: boolean;
  updatedAt: string;
}
export interface LibraryEvent extends RaceEvent {
  displayName: string;
  backgroundReady: boolean;
  backgroundVersion: string | null;
  images: {
    session: SessionKey;
    label: string;
    thumbnail: string;
    png: string;
    svg: string;
  }[];
}
export interface PublicLibrary {
  seasons: number[];
  season: number;
  events: LibraryEvent[];
  lastSync: string | null;
  nextSync: string | null;
  syncError: string | null;
  frozen: boolean;
}
export interface AppSettings {
  modelId: string;
  monthlyGenerationLimit: number;
  autoGenerate: boolean;
  resolution: string;
  quality: string;
  embyLibraryId: string;
  embySeriesId: string;
}
export interface Capability {
  type: string;
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
}
export interface ImageModel {
  id: string;
  name: string;
  created?: number;
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  parameters: Record<string, Capability>;
  route: "images" | "chat";
}
export interface OpenRouterUsage {
  total: number;
  daily: number;
  weekly: number;
  monthly: number;
  byokTotal: number | null;
  fetchedAt: string;
}
export const overlayElements = {
  logo: "F1 logo",
  title: "Venue title",
  session: "Session label",
  round: "Year and round",
} as const;
export type OverlayElement = keyof typeof overlayElements;
// Linked colours apply to every session; unlinked ones may differ per session.
export interface OverlayColour {
  linked: boolean;
  colour: string;
  sessions: Partial<Record<SessionKey, string>>;
}
export type OverlayColours = Record<OverlayElement, OverlayColour>;
export const resolveColour = (
  colours: OverlayColours,
  element: OverlayElement,
  session: SessionKey,
) => {
  const setting = colours[element];
  return setting.linked
    ? setting.colour
    : setting.sessions[session] || setting.colour;
};
export interface Glyph {
  d: string;
  transform: string;
}
export interface StudioVersion {
  id: string;
  number: number;
  source: "current" | "generate" | "feedback" | "upload";
  parentId: string | null;
  feedback: string | null;
  model: string | null;
  createdAt: string;
  live: boolean;
  preview: string;
  thumbnail: string;
}
export interface StudioState {
  event: {
    id: string;
    season: number;
    round: number;
    name: string;
    circuit: string;
    locality: string;
    country: string;
    displayName: string;
  };
  sessions: SessionKey[];
  versions: StudioVersion[];
  draft: {
    selectedVersionId: string | null;
    colours: OverlayColours;
    updatedAt: string;
  } | null;
  defaultColours: OverlayColours;
  approvedColours: OverlayColours;
  overlay: {
    logo: {
      svg: string;
      fill: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };
    title: Glyph[];
    round: Glyph[];
    sessions: Partial<Record<SessionKey, Glyph[]>>;
  };
  allowance: { used: number; limit: number };
  generation: { ready: boolean; referenceImages: boolean; reason: string };
  job: Job | null;
}

export interface Job {
  id: string;
  kind: "generate" | "studio" | "sync" | "emby";
  eventId: string | null;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  createdAt: string;
  finishedAt: string | null;
}
export interface EmbyMapping {
  eventId: string;
  session: SessionKey;
  itemId: string;
  itemName: string;
  lastImageVersion: string | null;
  lastSyncedAt: string | null;
  error: string | null;
}
export interface EmbyShow {
  id: string;
  name: string;
  path?: string;
}
export interface EmbyCandidate {
  itemId: string;
  name: string;
  path?: string;
  year?: number;
  candidates: { eventId: string; session: SessionKey; score: number }[];
}

export interface AdminStatus {
  settings: AppSettings;
  configured: { openrouter: boolean; emby: boolean };
  generationsThisMonth: number;
  jobs: Job[];
  mappings: EmbyMapping[];
}
