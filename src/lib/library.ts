import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

const getLibrary = createServerFn({ method: "GET" })
  .validator((data: { season: number }) => data)
  .handler(async ({ data }) => {
    const { buildLibrary } = await import("../../server/library.ts");
    return buildLibrary(data.season || undefined);
  });

// Season 0 means "whichever season is current"; the page refreshes once a minute.
export const libraryQuery = (season: number) =>
  queryOptions({
    queryKey: ["library", season],
    queryFn: () => getLibrary({ data: { season } }),
    refetchInterval: 60_000,
  });
