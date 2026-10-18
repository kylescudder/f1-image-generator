import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { App, Gallery } from "../components/App";
import { libraryQuery } from "../lib/library";

export const Route = createFileRoute("/")({
  validateSearch: z.object({ season: z.number().int().optional() }),
  loaderDeps: ({ search }) => ({ season: search.season ?? 0 }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(libraryQuery(deps.season)),
  component: Home,
});

function Home() {
  const { season } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  return (
    <App admin={false}>
      {(notify) => (
        <Gallery
          notify={notify}
          year={season ?? 0}
          onYear={(value) =>
            navigate({ search: { season: value }, replace: true })
          }
        />
      )}
    </App>
  );
}
