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
export interface Job {
  id: string;
  kind: "generate" | "sync" | "emby";
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
