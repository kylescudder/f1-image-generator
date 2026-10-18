import { useQuery } from "@tanstack/react-query";
import { DollarSign, RefreshCw } from "lucide-react";
import type { OpenRouterUsage } from "../../shared/types.ts";
import { request } from "../lib/api";

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

export function OpenRouterSpend({ configured }: { configured: boolean }) {
  const usage = useQuery({
    queryKey: ["openrouter-usage"],
    queryFn: () => request<OpenRouterUsage>("/api/admin/usage"),
    enabled: configured,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  return (
    <section className="settings-card" aria-labelledby="spending-heading">
      <div className="card-heading">
        <div className="card-icon">
          <DollarSign size={19} />
        </div>
        <div>
          <h2 id="spending-heading">OpenRouter spending</h2>
          <p>Live usage for your configured API key · USD</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh spending"
          disabled={!configured || usage.isFetching}
          onClick={() => void usage.refetch()}
        >
          <RefreshCw size={17} className={usage.isFetching ? "spin" : ""} />
        </button>
      </div>
      {!configured ? (
        <p className="field-hint">Connect OpenRouter to view spending.</p>
      ) : (
        <>
          {usage.isPending && <p role="status">Loading spending…</p>}
          {usage.isError && (
            <p className="alert error" role="alert">
              {usage.data
                ? "Refresh failed. Showing the last fetched amounts. "
                : ""}
              {usage.error.message} Use refresh to retry.
            </p>
          )}
          {usage.data && (
            <>
              <dl className="spending-totals">
                {(
                  [
                    ["All time", usage.data.total],
                    ["This month", usage.data.monthly],
                    ["This week", usage.data.weekly],
                    ["Today", usage.data.daily],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{dollars(value)}</dd>
                  </div>
                ))}
              </dl>
              {usage.data.byokTotal !== null && usage.data.byokTotal > 0 && (
                <p className="field-hint">
                  Bring-your-own-key usage: {dollars(usage.data.byokTotal)} all
                  time, reported separately by OpenRouter.
                </p>
              )}
              <p className="field-hint">
                Updated {new Date(usage.data.fetchedAt).toLocaleString("en-GB")}
              </p>
            </>
          )}
          <p className="field-hint">
            OpenRouter credit usage across all apps using this key. Periods use
            UTC; bring-your-own-key usage is separate.
          </p>
        </>
      )}
    </section>
  );
}
