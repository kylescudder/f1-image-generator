import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCalendar } from "../server/calendar.ts";
import { matchItem } from "../server/emby.ts";

const events = [2025, 2026].flatMap((year) =>
  parseCalendar(
    JSON.parse(readFileSync(`assets/calendars/${year}.json`, "utf8")),
    year,
  ),
);

test("episode matching uses the season, venue and session folders when titles are generic", () => {
  expect(
    matchItem(
      {
        Id: "folder-race",
        Name: "Episode 21",
        Path: "/tv/Formula 1 (1950)/Season 2026/17 Singapore/Sprint Qualifying/1080p.mkv",
      },
      events,
    ).candidates,
  ).toEqual([
    { eventId: "2026-singapore", session: "sprint-qualifying", score: 100 },
  ]);
});

test("a generic Grand Prix title does not override a qualifying filename", () => {
  expect(
    matchItem(
      {
        Id: "quali",
        Name: "Singapore Grand Prix",
        Path: "D:\\TV\\Formula 1\\Season 2026\\F1.S2026E17.Singapore.Qualifying.mkv",
      },
      events,
    ).candidates,
  ).toEqual([{ eventId: "2026-singapore", session: "qualifying", score: 100 }]);
});

test("practice and highlights are not inferred as races from their parent folders", () => {
  for (const file of ["FP.1.mkv", "Highlights.mkv", "Practice.mkv"]) {
    expect(
      matchItem(
        {
          Id: file,
          Name: "Singapore Grand Prix",
          Path: `/tv/Formula 1/2026/Singapore/Race/${file}`,
        },
        events,
      ).candidates,
    ).toEqual([]);
  }
});

test("missing years stay ambiguous across seasons and unknown venues stay unmapped", () => {
  const result = matchItem({ Id: "no-year", Name: "Singapore Race" }, events);
  expect(result.candidates.map(({ eventId }) => eventId)).toEqual([
    "2025-singapore",
    "2026-singapore",
  ]);
  expect(result.candidates.every(({ score }) => score < 100)).toBe(true);
  expect(
    matchItem(
      { Id: "unknown", Name: "Episode 1", Path: "/tv/F1/2026/unknown.mkv" },
      events,
    ).candidates,
  ).toEqual([]);
});

test("video resolution in a filename does not replace the season folder's year", () => {
  expect(
    matchItem(
      {
        Id: "resolution",
        Name: "Episode 1",
        Path: "/tv/Formula 1/2026/Singapore/Race/1920x1080.mkv",
      },
      events,
    ).candidates,
  ).toEqual([{ eventId: "2026-singapore", session: "race", score: 100 }]);
});

test("unrelated ancestor folders do not exclude a competitive episode", () => {
  for (const ancestor of [
    "review",
    "preview",
    "highlights",
    "practice",
    "notebook",
    "fp1",
  ]) {
    expect(
      matchItem(
        {
          Id: "ancestor-race",
          Name: "Episode 1",
          Path: `/srv/${ancestor}/Formula 1/2026/Singapore/Race.mkv`,
        },
        events,
      ).candidates,
    ).toEqual([{ eventId: "2026-singapore", session: "race", score: 100 }]);
  }
});

test("episode names, filenames and adjacent session folders still exclude noncompetitive footage", () => {
  for (const item of [
    {
      Name: "Singapore Race Highlights",
      Path: "/tv/Formula 1/2026/Singapore/Race.mkv",
    },
    {
      Name: "Episode 1",
      Path: "/tv/Formula 1/2026/Singapore/Highlights/video.mkv",
    },
    {
      Name: "Episode 1",
      Path: "/tv/Formula 1/2026/Singapore/Highlights/Race/video.mkv",
    },
    {
      Name: "Episode 1",
      Path: "/tv/Formula 1/2026/Singapore/Race/Highlights/video.mkv",
    },
    { Name: "Episode 1", Path: "/tv/Formula 1/2026/Singapore/FP.1/video.mkv" },
  ]) {
    expect(matchItem({ Id: "excluded", ...item }, events).candidates).toEqual(
      [],
    );
  }
});
