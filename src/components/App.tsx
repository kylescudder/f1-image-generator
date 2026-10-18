import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SignIn, UserButton, useAuth } from "@clerk/tanstack-react-start";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  Copy,
  ExternalLink,
  Film,
  Flag,
  ImagePlus,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Menu,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { libraryQuery } from "../lib/library";
import {
  sessions,
  type AdminStatus,
  type AppSettings,
  type EmbyCandidate,
  type EmbyShow,
  type ImageModel,
  type LibraryEvent,
  type PublicLibrary,
  type SessionKey,
} from "../../shared/types.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}
const post = <T,>(url: string, body?: unknown) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body || {}) });
const raceLabel = (event: LibraryEvent) =>
  event.name
    .replace(/ Grand Prix.*$/i, "")
    .replace(/\bGrand Prix\b/i, "")
    .trim();
const prettyDate = (
  value: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", {
        ...options,
        timeZone: "UTC",
      })
    : "Calendar archive";
const dateRange = (event: LibraryEvent) =>
  !event.date
    ? "Removed from calendar"
    : `${prettyDate(event.startDate, { day: "numeric" })}–${prettyDate(event.date)}`;
const timestamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Paddock home">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        paddock<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}
function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function App({
  admin,
  children,
}: {
  admin: boolean;
  children: (notify: (text: string) => void) => ReactNode;
}) {
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  };
  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="topbar-middle">
          <span className="tiny-square" /> THE FORMULA 1 ARTWORK COLLECTION
        </div>
        <Link
          className={`admin-link ${admin ? "active" : ""}`}
          to={admin ? "/" : "/admin"}
        >
          {admin ? <ArrowLeft size={14} /> : <LockKeyhole size={14} />}
          <span>{admin ? "Back to collection" : "Owner workspace"}</span>
        </Link>
      </header>
      {children(notify)}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}

export function Gallery({
  notify,
  year,
  onYear,
}: {
  notify: (text: string) => void;
  year: number;
  onYear: (season: number) => void;
}) {
  const library = useQuery(libraryQuery(year));
  const data: PublicLibrary | null = library.data ?? null;
  const error = library.error ? errorMessage(library.error) : "";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "sprint" | "archive">("all");
  const [count, setCount] = useState(6);
  const [viewing, setViewing] = useState<{
    event: LibraryEvent;
    session: SessionKey;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (event.target as HTMLElement).tagName,
        )
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const chooseYear = (value: number) => {
    onYear(value);
    setSearch("");
    setFilter("all");
    setCount(6);
  };
  const active = data?.events.filter((event) => !event.cancelled) || [];
  const archived = data?.events.filter((event) => event.cancelled) || [];
  const sprintCount = active.filter((event) => event.sprint).length;
  const imageCount = active.reduce(
    (sum, event) => sum + event.images.length,
    0,
  );
  const today = new Date().toISOString().slice(0, 10);
  const featured =
    active.find((event) => event.date >= today && event.backgroundReady) ||
    active.filter((event) => event.backgroundReady).at(-1);
  const filtered = (filter === "archive" ? archived : active).filter(
    (event) =>
      (filter !== "sprint" || event.sprint) &&
      `${event.name} ${event.country} ${event.locality} ${event.circuit} ${event.round}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-section-label">YOUR COLLECTION</div>
        <Link to="/" className="nav-item selected">
          <Layers3 size={17} />
          Season library
          <ArrowUpRight size={14} />
        </Link>
        <div className="sidebar-rule" />
        <div className="sidebar-section-label">CHAMPIONSHIP SEASONS</div>
        <div className="season-nav">
          {(data?.seasons || [2026, 2025]).map((season) => (
            <button
              key={season}
              className={`season-button ${(data?.season || year || 2026) === season ? "selected" : ""}`}
              onClick={() => chooseYear(season)}
            >
              <span className="season-number">{season}</span>
              <span className="season-caption">
                {season === new Date().getUTCFullYear()
                  ? "Current season"
                  : season < new Date().getUTCFullYear()
                    ? "The archive"
                    : "Coming up"}
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        <div className="sidebar-note">
          <span className="live-dot" />
          <strong>Always on the calendar.</strong>
          <p>
            New rounds. New formats.
            <br />
            Your artwork keeps up.
          </p>
          <span>
            Checks every 6 hours <Clock3 size={12} />
          </span>
        </div>
        <Link className="sidebar-bottom" to="/admin">
          <Settings2 size={15} />
          Manage library
          <ArrowUpRight size={13} />
        </Link>
      </aside>
      <main className="collection">
        <div className="collection-eyebrow">
          <span>THE PADDOCK / SEASON {data?.season || year || "…"}</span>
          <span className="sync-indicator">
            <span
              className={data?.syncError ? "status-dot warning" : "status-dot"}
            />
            {data?.syncError
              ? "Sync needs attention"
              : data?.lastSync
                ? "Calendar synced"
                : "Calendar imported"}
          </span>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {error}
            <button onClick={() => location.reload()}>Retry</button>
          </div>
        )}
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">A SEASON. EVERY SESSION.</div>
            <h1>
              Race weekends,
              <br />
              <span>beautifully covered.</span>
            </h1>
            <p>
              Your Formula 1 collection, ready for the big screen.
              <br className="desktop-break" /> Every qualifying. Every sprint.
              Every Grand Prix.
            </p>
            <a href="#weekends" className="text-link">
              Explore the {data?.season || year || 2026} collection{" "}
              <ArrowRight size={15} />
            </a>
          </div>
          {featured ? (
            <button
              className="featured"
              onClick={() => setViewing({ event: featured, session: "race" })}
              aria-label={`Expand ${raceLabel(featured)} race image`}
            >
              <img
                src={`${featured.images.find((image) => image.session === "race")!.png}&width=1920`}
                alt={`${raceLabel(featured)} Grand Prix race artwork`}
              />
              <div className="featured-top">
                <span>
                  {featured.date >= today ? "UP NEXT" : "FROM THE COLLECTION"}
                </span>
                <span>
                  <span className="status-dot" />
                  ROUND {String(featured.round).padStart(2, "0")}
                </span>
              </div>
              <span className="featured-expand">
                <ArrowUpRight size={18} />
              </span>
            </button>
          ) : (
            <div className="featured loading-art">
              <Flag size={32} />
            </div>
          )}
        </section>
        <div className="collection-stats">
          <div>
            <strong>{active.length || "—"}</strong>
            <span>race weekends</span>
          </div>
          <div>
            <strong>{imageCount || "—"}</strong>
            <span>session artworks</span>
          </div>
          <div>
            <strong>{sprintCount || "—"}</strong>
            <span>sprint weekends</span>
          </div>
          <div className="format-stat">
            <span className="format-icon">
              <ImagePlus size={20} />
            </span>
            <div>
              <b>Ready for Emby</b>
              <span>4K PNG + hybrid SVG</span>
            </div>
            <Badge tone="subtle">16:9</Badge>
          </div>
        </div>
        <section id="weekends" className="weekends">
          <div className="collection-toolbar">
            <div className="filter-tabs" aria-label="Weekend filters">
              <button
                className={filter === "all" ? "selected" : ""}
                onClick={() => {
                  setFilter("all");
                  setCount(6);
                }}
              >
                All weekends <span>{active.length}</span>
              </button>
              <button
                className={filter === "sprint" ? "selected" : ""}
                onClick={() => {
                  setFilter("sprint");
                  setCount(6);
                }}
              >
                <Zap size={13} />
                Sprints <span>{sprintCount}</span>
              </button>
              {archived.length > 0 && (
                <button
                  className={filter === "archive" ? "selected" : ""}
                  onClick={() => {
                    setFilter("archive");
                    setCount(6);
                  }}
                >
                  Archive <span>{archived.length}</span>
                </button>
              )}
            </div>
            <label className="search-box">
              <Search size={16} />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setCount(6);
                }}
                placeholder="Find a Grand Prix…"
                aria-label="Find a Grand Prix"
              />
              {search ? (
                <button onClick={() => setSearch("")} aria-label="Clear search">
                  <X size={13} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </label>
          </div>
          <div className="list-heading">
            <span>
              {filter === "archive"
                ? "CANCELLED WEEKENDS"
                : "THE RACE WEEKENDS"}
            </span>
            <span>
              CHAMPIONSHIP ORDER <ChevronDown size={11} />
            </span>
          </div>
          {!data && !error && (
            <div className="library-loading">
              <LoaderCircle className="spin" size={24} />
              Preparing your collection…
            </div>
          )}
          {data && filtered.length === 0 && (
            <div className="empty-state">
              <Search size={28} />
              <h2>No weekends found</h2>
              <p>Try a circuit, country, or Grand Prix name.</p>
              <button
                className="button secondary"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                Show all weekends
              </button>
            </div>
          )}
          {filtered.slice(0, count).map((event) => (
            <section className="weekend" key={event.id}>
              <div className="weekend-header">
                <div className="round-number">
                  {String(event.round).padStart(2, "0")}
                </div>
                <div className="weekend-title">
                  <h2>
                    {raceLabel(event)} <span>Grand Prix</span>
                  </h2>
                  <p>
                    {event.circuit}
                    <span>·</span>
                    {dateRange(event)}
                  </p>
                </div>
                <div className="weekend-badges">
                  {event.cancelled ? (
                    <Badge>Archived</Badge>
                  ) : event.sprint ? (
                    <Badge tone="sprint">
                      <Zap size={10} />
                      Sprint weekend
                    </Badge>
                  ) : (
                    <Badge tone="subtle">Race weekend</Badge>
                  )}
                  <span className="session-count">
                    {event.images.length} artworks
                  </span>
                </div>
              </div>
              <div
                className={`session-grid ${event.sprint ? "sprint-grid" : ""}`}
              >
                {event.images.map((image, index) => (
                  <ArtworkCard
                    key={image.session}
                    event={event}
                    session={image.session}
                    index={index}
                    expand={() => setViewing({ event, session: image.session })}
                    notify={notify}
                  />
                ))}
              </div>
            </section>
          ))}
          {filtered.length > count && (
            <div className="load-more">
              <button
                className="button secondary"
                onClick={() => setCount((value) => value + 6)}
              >
                More race weekends <ChevronDown size={15} />
              </button>
              <span>
                Showing {Math.min(count, filtered.length)} of {filtered.length}{" "}
                weekends
              </span>
            </div>
          )}
        </section>
        <footer className="collection-footer">
          <span>
            <span className="brand-mini">p.</span> Every session deserves a good
            cover.
          </span>
          <span>
            {data?.frozen
              ? "Completed season · archived"
              : `Last calendar check: ${timestamp(data?.lastSync || null)}`}
            <span className="footer-dot">·</span>
            <a
              href="https://api.jolpi.ca/ergast/"
              target="_blank"
              rel="noreferrer"
            >
              Calendar by Jolpica <ExternalLink size={10} />
            </a>
          </span>
        </footer>
      </main>
      {viewing && (
        <ImageViewer
          viewing={viewing}
          close={() => setViewing(null)}
          change={setViewing}
          notify={notify}
        />
      )}
    </div>
  );
}

async function copyImage(url: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error(
      "Image copying needs a supported browser over HTTPS. Use Download PNG instead.",
    );
  // Construct ClipboardItem immediately, preserving Safari's user-activation window.
  const image = fetch(url).then(async (response) => {
    if (!response.ok) throw new Error("Could not fetch the image.");
    return response.blob();
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
}
function ArtworkCard({
  event,
  session,
  index,
  expand,
  notify,
}: {
  event: LibraryEvent;
  session: SessionKey;
  index: number;
  expand: () => void;
  notify: (text: string) => void;
}) {
  const image = event.images.find((image) => image.session === session)!;
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <article
      className={`artwork-card ${event.backgroundReady ? "" : "pending-art"}`}
    >
      <div className="artwork-frame">
        <button
          className="image-open"
          onClick={expand}
          aria-label={`Expand ${raceLabel(event)} ${image.label}`}
        >
          <img
            loading="lazy"
            src={image.thumbnail}
            alt={`${event.season} ${raceLabel(event)} — ${image.label}, round ${event.round}`}
          />
          <span className="image-shade" />
          <span className="expand-hint">
            <ArrowUpRight size={17} />
            View artwork
          </span>
        </button>
        <button
          className={`copy-image ${copied ? "copied" : ""}`}
          title="Copy image"
          aria-label={`Copy ${raceLabel(event)} ${image.label} image`}
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            try {
              await copyImage(image.png);
              setCopied(true);
              notify("Image copied. Ready to paste.");
              setTimeout(() => setCopied(false), 2500);
            } catch (error) {
              notify(errorMessage(error));
            } finally {
              setCopying(false);
            }
          }}
        >
          {copying ? (
            <LoaderCircle className="spin" size={15} />
          ) : copied ? (
            <Check size={15} />
          ) : (
            <Copy size={15} />
          )}
        </button>
        {!event.backgroundReady && (
          <span className="pending-label">
            <Sparkles size={11} />
            Background pending
          </span>
        )}
      </div>
      <div className="artwork-caption">
        <span className="session-index">
          {String(index + 1).padStart(2, "0")}
        </span>
        <strong>{image.label}</strong>
        <span className="artwork-format">PNG / SVG</span>
        <a
          href={`${image.png}&download=1`}
          title="Download PNG"
          aria-label={`Download ${image.label} PNG`}
        >
          <ArrowDownToLine size={14} />
        </a>
      </div>
    </article>
  );
}
function ImageViewer({
  viewing,
  close,
  change,
  notify,
}: {
  viewing: { event: LibraryEvent; session: SessionKey };
  close: () => void;
  change: (value: { event: LibraryEvent; session: SessionKey }) => void;
  notify: (text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { event, session } = viewing;
  const image = event.images.find((image) => image.session === session)!;
  const index = event.images.findIndex((image) => image.session === session);
  const previous = () =>
    change({
      event,
      session:
        event.images[(index - 1 + event.images.length) % event.images.length]
          .session,
    });
  const next = () =>
    change({
      event,
      session: event.images[(index + 1) % event.images.length].session,
    });
  useEffect(() => {
    dialog.current?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-dialog"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") next();
        if (event.key === "ArrowLeft") previous();
      }}
      aria-label={`${raceLabel(viewing.event)} ${image.label} artwork`}
    >
      <div className="viewer-top">
        <div>
          <span className="eyebrow">
            {event.season} / ROUND {event.round}
          </span>
          <h2>
            {raceLabel(event)} <span>· {image.label}</span>
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close artwork"
          onClick={close}
        >
          <X size={23} />
        </button>
      </div>
      <div className="viewer-image">
        <img
          src={image.png}
          alt={`${raceLabel(event)} ${image.label} full-size artwork`}
        />
      </div>
      <div className="viewer-bottom">
        <div className="viewer-pages">
          <button
            className="icon-button"
            onClick={previous}
            aria-label="Previous session"
          >
            <ChevronLeft size={19} />
          </button>
          <span>
            {index + 1} / {event.images.length}
          </span>
          <button
            className="icon-button"
            onClick={next}
            aria-label="Next session"
          >
            <ChevronRight size={19} />
          </button>
        </div>
        <div className="viewer-actions">
          <button
            className="button secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  new URL(image.png.split("?")[0], location.origin).href,
                );
                notify("Stable image URL copied.");
              } catch {
                notify("Your browser could not copy the link.");
              }
            }}
          >
            <Link2 size={14} />
            Copy link
          </button>
          <a className="button secondary" href={`${image.svg}&download=1`}>
            <ArrowDownToLine size={14} />
            SVG
          </a>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await copyImage(image.png);
                notify("Image copied. Ready to paste.");
              } catch (error) {
                notify(errorMessage(error));
              }
            }}
          >
            <Copy size={14} />
            Copy image
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function AdminGate({
  authConfigured,
  hasClerk,
  notify,
}: {
  authConfigured: boolean;
  hasClerk: boolean;
  notify: (text: string) => void;
}) {
  if (!authConfigured || !hasClerk)
    return (
      <main className="setup-page">
        <div className="setup-icon">
          <LockKeyhole size={28} />
        </div>
        <div className="eyebrow">OWNER WORKSPACE</div>
        <h1>
          Your collection.
          <br />
          Your controls.
        </h1>
        <p>
          The public library is ready. Connect your Clerk account on Herman to
          unlock settings, generation, and Emby sync.
        </p>
        <div className="setup-checklist">
          <span>
            <Check size={16} />
            Public gallery available
          </span>
          <span>
            <LockKeyhole size={16} />
            Administration locked until configured
          </span>
          <span>
            <Sparkles size={16} />
            Generation requires your owner login
          </span>
        </div>
        <Link className="button secondary" to="/">
          <ArrowLeft size={15} />
          Back to collection
        </Link>
      </main>
    );
  return <AuthenticatedAdmin notify={notify} />;
}
function AuthenticatedAdmin({ notify }: { notify: (text: string) => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (isLoaded && isSignedIn)
      request("/api/admin/me")
        .then(() => setOwner(true))
        .catch((error) => setError(errorMessage(error)));
  }, [isLoaded, isSignedIn]);
  if (!isLoaded)
    return (
      <div className="library-loading">
        <LoaderCircle className="spin" />
        Loading your workspace…
      </div>
    );
  if (!isSignedIn)
    return (
      <main className="sign-in-page">
        <div className="eyebrow">OWNER WORKSPACE</div>
        <h1>Welcome back.</h1>
        <p>Sign in with your approved account to manage Paddock.</p>
        <SignIn routing="hash" forceRedirectUrl="/admin" />
      </main>
    );
  if (error)
    return (
      <main className="setup-page">
        <LockKeyhole size={30} />
        <h1>This workspace is private.</h1>
        <p>{error}</p>
        <UserButton />
        <Link className="text-link" to="/">
          Return to the collection <ArrowRight size={15} />
        </Link>
      </main>
    );
  return owner ? (
    <Admin notify={notify} />
  ) : (
    <div className="library-loading">
      <LoaderCircle className="spin" />
      Checking owner access…
    </div>
  );
}

function Admin({ notify }: { notify: (text: string) => void }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"settings" | "emby" | "activity">("settings");
  const [models, setModels] = useState<ImageModel[]>([]);
  const [modelFetched, setModelFetched] = useState("");
  const [modelStale, setModelStale] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [library, setLibrary] = useState<PublicLibrary | null>(null);
  const [allEvents, setAllEvents] = useState<LibraryEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState("");
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [shows, setShows] = useState<EmbyShow[]>([]);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsLibrary, setShowsLibrary] = useState("");
  const [showsRefresh, setShowsRefresh] = useState(0);
  const [inspected, setInspected] = useState(false);
  const [candidates, setCandidates] = useState<EmbyCandidate[]>([]);
  const [episodeSearch, setEpisodeSearch] = useState("");
  const reload = async () => {
    const result = await request<AdminStatus>("/api/admin/status");
    setStatus(result);
    setSettings((previous) => previous || result.settings);
  };
  const act = async (
    name: string,
    task: () => Promise<unknown>,
    message?: string,
  ) => {
    setBusy(name);
    setError("");
    try {
      await task();
      if (message) notify(message);
      await reload();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };
  const loadModels = async (refresh = false) => {
    const result = await request<{
      models: ImageModel[];
      fetchedAt: string;
      stale: boolean;
    }>(`/api/admin/models${refresh ? "?refresh=true" : ""}`);
    setModels(result.models);
    setModelFetched(result.fetchedAt);
    setModelStale(result.stale);
  };
  useEffect(() => {
    void reload().catch((error) => setError(errorMessage(error)));
    void loadModels().catch((error) => setError(errorMessage(error)));
    void request<PublicLibrary>("/api/library")
      .then(setLibrary)
      .catch(() => {});
    void request<LibraryEvent[]>("/api/admin/events")
      .then(setAllEvents)
      .catch(() => {});
    const timer = setInterval(() => {
      void reload().catch(() => {});
      void request<PublicLibrary>("/api/library")
        .then(setLibrary)
        .catch(() => {});
      void request<LibraryEvent[]>("/api/admin/events")
        .then(setAllEvents)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const libraryId = settings?.embyLibraryId;
    if (tab !== "emby" || !libraryId || !status?.configured.emby) return;
    let cancelled = false;
    setShowsLoading(true);
    setShowsLibrary("");
    setShows([]);
    request<EmbyShow[]>(
      `/api/admin/emby/shows?libraryId=${encodeURIComponent(libraryId)}`,
    )
      .then((result) => {
        if (!cancelled) {
          setShows(result);
          setShowsLibrary(libraryId);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setShowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.embyLibraryId, status?.configured.emby, tab, showsRefresh]);
  if (!settings || !status)
    return (
      <div className="library-loading">
        <LoaderCircle className="spin" />
        Opening your workspace…
      </div>
    );
  const model = models.find((model) => model.id === settings.modelId);
  const options = (field: string) =>
    model?.parameters[field]?.values?.filter(
      (value): value is string => typeof value === "string",
    ) || [];
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSettings((previous) =>
      previous ? { ...previous, [key]: value } : previous,
    );
  const save = async () => {
    const saved = await post<AppSettings>("/api/admin/settings", settings);
    setSettings(saved);
  };
  const weekends = allEvents
    .filter((event) => !event.cancelled)
    .sort((a, b) => b.season - a.season || a.round - b.round);
  const selected = weekends.find((event) => event.id === selectedEvent);
  const filteredModels = models.filter((model) =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(modelSearch.toLowerCase()),
  );
  const suggestions = candidates.filter(
    (candidate) =>
      candidate.candidates.length === 1 &&
      candidate.candidates[0].score === 100 &&
      !status.mappings.some((mapping) => mapping.itemId === candidate.itemId),
  );
  return (
    <main className="admin-main">
      <div className="admin-heading">
        <div>
          <div className="eyebrow">YOUR PRIVATE WORKSPACE</div>
          <h1>Keep the collection moving.</h1>
          <p>One calendar. Your models. Everything in its place.</p>
        </div>
        <UserButton />
      </div>
      <div className="admin-tabs">
        <button
          className={tab === "settings" ? "selected" : ""}
          onClick={() => setTab("settings")}
        >
          <Settings2 size={15} />
          Settings
        </button>
        <button
          className={tab === "emby" ? "selected" : ""}
          onClick={() => setTab("emby")}
        >
          <Film size={15} />
          Emby
        </button>
        <button
          className={tab === "activity" ? "selected" : ""}
          onClick={() => setTab("activity")}
        >
          <Clock3 size={15} />
          Activity
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={15} />
          </button>
        </div>
      )}
      {tab === "settings" && (
        <div className="admin-grid">
          <section className="settings-card">
            <div className="card-heading">
              <div className="card-icon">
                <Sparkles size={19} />
              </div>
              <div>
                <h2>Image generation</h2>
                <p>Choose any image model available on OpenRouter.</p>
              </div>
              <button
                className="icon-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void act(
                    "models",
                    () => loadModels(true),
                    "Model catalogue refreshed.",
                  )
                }
                aria-label="Refresh image models"
              >
                <RefreshCw
                  className={busy === "models" ? "spin" : ""}
                  size={17}
                />
              </button>
            </div>
            {!status.configured.openrouter && (
              <div className="alert">
                <CircleHelp size={16} />
                <span>
                  Add your OpenRouter API key to Herman’s environment to enable
                  generation.
                </span>
              </div>
            )}
            <label className="field">
              Find a model
              <input
                placeholder="Search providers and image models…"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
              />
            </label>
            <label className="field">
              Image model
              <select
                value={settings.modelId}
                onChange={(event) => {
                  const choice = models.find(
                    (model) => model.id === event.target.value,
                  );
                  setSettings({
                    ...settings,
                    modelId: event.target.value,
                    resolution: choice?.parameters.resolution?.values?.includes(
                      "2K",
                    )
                      ? "2K"
                      : String(
                          choice?.parameters.resolution?.values?.[0] || "",
                        ),
                    quality: choice?.parameters.quality?.values?.includes(
                      "high",
                    )
                      ? "high"
                      : String(choice?.parameters.quality?.values?.[0] || ""),
                  });
                }}
              >
                <option value="">Select an image-generation model</option>
                {settings.modelId &&
                  !filteredModels.some(
                    (model) => model.id === settings.modelId,
                  ) && (
                    <option value={settings.modelId}>
                      {model?.name || `${settings.modelId} (unavailable)`}
                    </option>
                  )}
                {filteredModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-hint">
              {models.length} image models · Updated {timestamp(modelFetched)}
              {modelStale && " · Cached catalogue; refresh to retry"}
            </div>
            {model && (
              <div className="model-detail">
                <strong>{model.name}</strong>
                <span>
                  {model.inputModalities.includes("image")
                    ? "Reference images supported"
                    : "Text prompts only"}{" "}
                  ·{" "}
                  {model.route === "images"
                    ? "Image model"
                    : "Multimodal model"}
                </span>
              </div>
            )}
            <div className="field-row">
              <label className="field">
                Resolution
                <select
                  value={settings.resolution}
                  onChange={(event) => update("resolution", event.target.value)}
                >
                  {options("resolution").length ? (
                    options("resolution").map((value) => (
                      <option key={value}>{value}</option>
                    ))
                  ) : (
                    <option value="">Provider default</option>
                  )}
                </select>
              </label>
              <label className="field">
                Quality
                <select
                  value={settings.quality}
                  onChange={(event) => update("quality", event.target.value)}
                >
                  {options("quality").length ? (
                    options("quality").map((value) => (
                      <option key={value}>{value}</option>
                    ))
                  ) : (
                    <option value="">Provider default</option>
                  )}
                </select>
              </label>
            </div>
            <div className="settings-divider" />
            <label className="toggle-row">
              <div>
                <strong>Fill missing venue artwork automatically</strong>
                <span>
                  Existing illustrations are reused across sessions and seasons.
                </span>
              </div>
              <input
                type="checkbox"
                checked={settings.autoGenerate}
                onChange={(event) =>
                  update("autoGenerate", event.target.checked)
                }
                role="switch"
              />
            </label>
            <label className="field allowance">
              Monthly generation allowance
              <input
                type="number"
                min="0"
                max="100"
                value={settings.monthlyGenerationLimit}
                onChange={(event) =>
                  update("monthlyGenerationLimit", Number(event.target.value))
                }
              />
            </label>
            <div className="allowance-meter">
              <div
                style={{
                  width: `${Math.min(100, (status.generationsThisMonth / Math.max(1, settings.monthlyGenerationLimit)) * 100)}%`,
                }}
              />
            </div>
            <div className="field-hint">
              {status.generationsThisMonth} of {settings.monthlyGenerationLimit}{" "}
              attempts used this month. Failed attempts count. OpenRouter bills
              usage separately.
            </div>
            <button
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void act(
                  "save",
                  save,
                  "Generation settings saved. Missing venues will be queued if enabled.",
                )
              }
            >
              {busy === "save" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              Save settings
            </button>
          </section>
          <div className="settings-stack">
            <section className="settings-card">
              <div className="card-heading">
                <div className="card-icon">
                  <RefreshCw size={19} />
                </div>
                <div>
                  <h2>Calendar sync</h2>
                  <p>Your artwork follows the official season.</p>
                </div>
              </div>
              <dl className="settings-facts">
                <div>
                  <dt>Last check</dt>
                  <dd>{timestamp(library?.lastSync || null)}</dd>
                </div>
                <div>
                  <dt>Next check</dt>
                  <dd>{timestamp(library?.nextSync || null)}</dd>
                </div>
                <div>
                  <dt>Schedule</dt>
                  <dd>Every 6 hours</dd>
                </div>
              </dl>
              <p className="field-hint">
                Cancelled weekends stay in the archive. Completed seasons are
                frozen after their final calendar is applied.
              </p>
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void act(
                    "sync",
                    () => post("/api/admin/sync"),
                    "Calendar sync queued. Follow progress in Activity.",
                  )
                }
              >
                <RefreshCw size={14} />
                Sync now
              </button>
            </section>
            <section className="settings-card">
              <div className="card-heading">
                <div className="card-icon">
                  <ImagePlus size={19} />
                </div>
                <div>
                  <h2>Venue artwork</h2>
                  <p>Generate a new scene or bring your own.</p>
                </div>
              </div>
              <label className="field">
                Race weekend
                <select
                  value={selectedEvent}
                  onChange={(event) => setSelectedEvent(event.target.value)}
                >
                  <option value="">Choose a weekend</option>
                  {weekends.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.season} · R{event.round} · {raceLabel(event)}
                      {event.backgroundReady ? "" : " — missing artwork"}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <p className="field-hint">
                  {selected.circuit}, {selected.country}. Replacing its
                  background updates all sessions using this venue.
                </p>
              )}
              <div className="button-row">
                <button
                  className="button secondary"
                  disabled={
                    Boolean(busy) ||
                    !selectedEvent ||
                    !status.configured.openrouter ||
                    !status.settings.modelId
                  }
                  onClick={() =>
                    void act(
                      "generate",
                      () =>
                        post("/api/admin/generate", { eventId: selectedEvent }),
                      "Background generation queued. Follow progress in Activity.",
                    )
                  }
                >
                  <Sparkles size={14} />
                  Generate background
                </button>
                <label
                  className={`button secondary upload-button ${!selectedEvent || busy ? "disabled" : ""}`}
                >
                  <Upload size={14} />
                  Upload
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={!selectedEvent || Boolean(busy)}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 20 * 1024 * 1024) {
                        setError("Choose an image smaller than 20 MB.");
                        return;
                      }
                      void act(
                        "upload",
                        async () => {
                          const image = await new Promise<string>(
                            (resolve, reject) => {
                              const reader = new FileReader();
                              reader.onload = () =>
                                resolve(String(reader.result));
                              reader.onerror = reject;
                              reader.readAsDataURL(file);
                            },
                          );
                          await post("/api/admin/background", {
                            eventId: selectedEvent,
                            image,
                          });
                        },
                        "Venue background replaced.",
                      );
                    }}
                  />
                </label>
              </div>
            </section>
            <div className="owner-note">
              <LockKeyhole size={16} />
              <p>
                Only your configured Clerk account can change settings, generate
                artwork, or update Emby.
              </p>
            </div>
          </div>
        </div>
      )}
      {tab === "emby" && (
        <div className="settings-card emby-settings">
          <div className="card-heading">
            <div className="card-icon">
              <Film size={21} />
            </div>
            <div>
              <h2>Your Emby connection</h2>
              <p>
                Review the mapping once. Artwork updates follow automatically.
              </p>
            </div>
            <Badge tone={status.configured.emby ? "connected" : ""}>
              {status.configured.emby ? "Configured" : "Not connected"}
            </Badge>
          </div>
          {!status.configured.emby && (
            <div className="alert">
              Add your Emby server URL and API key to Herman’s environment, then
              restart Paddock.
            </div>
          )}
          <div className="button-row">
            <button
              className="button secondary"
              disabled={Boolean(busy) || !status.configured.emby}
              onClick={() =>
                void act("libraries", async () => {
                  setLibraries(await request("/api/admin/emby/libraries"));
                  setShowsRefresh((value) => value + 1);
                })
              }
            >
              <RefreshCw size={14} />
              Load Emby libraries
            </button>
            <button
              className="button primary"
              disabled={
                Boolean(busy) ||
                !status.mappings.length ||
                !status.configured.emby
              }
              onClick={() =>
                void act(
                  "emby",
                  () => post("/api/admin/emby/sync"),
                  "Emby artwork update queued.",
                )
              }
            >
              <ArrowUpRight size={14} />
              Update Emby now
            </button>
          </div>
          <label className="field">
            Emby library
            <select
              aria-label="Emby library"
              value={settings.embyLibraryId}
              disabled={Boolean(busy)}
              onChange={(event) => {
                setSettings({
                  ...settings,
                  embyLibraryId: event.target.value,
                  embySeriesId: "",
                });
                setCandidates([]);
                setInspected(false);
                setEpisodeSearch("");
              }}
            >
              <option value="">Select a library</option>
              {settings.embyLibraryId &&
                !libraries.some(
                  (library) => library.id === settings.embyLibraryId,
                ) && (
                  <option value={settings.embyLibraryId}>
                    {settings.embyLibraryId}
                  </option>
                )}
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </label>
          {settings.embyLibraryId && (
            <>
              <label className="field">
                TV show
                <select
                  aria-label="TV show"
                  value={settings.embySeriesId}
                  disabled={
                    Boolean(busy) ||
                    showsLoading ||
                    showsLibrary !== settings.embyLibraryId
                  }
                  onChange={(event) => {
                    update("embySeriesId", event.target.value);
                    setCandidates([]);
                    setInspected(false);
                    setEpisodeSearch("");
                  }}
                >
                  <option value="">
                    {showsLoading
                      ? "Loading TV shows…"
                      : "All episodes in this library"}
                  </option>
                  {settings.embySeriesId &&
                    !shows.some(
                      (show) => show.id === settings.embySeriesId,
                    ) && (
                      <option value={settings.embySeriesId}>
                        {settings.embySeriesId}
                      </option>
                    )}
                  {shows.map((show) => (
                    <option key={show.id} value={show.id}>
                      {show.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">
                Choose Formula 1 to inspect only that show's episodes across all
                seasons.
                {showsLibrary === settings.embyLibraryId &&
                  !shows.length &&
                  " No TV shows were found; you can inspect the library directly."}
              </p>
            </>
          )}
          <div className="button-row">
            <button
              className="button secondary"
              disabled={
                Boolean(busy) ||
                showsLoading ||
                showsLibrary !== settings.embyLibraryId ||
                !settings.embyLibraryId
              }
              onClick={() =>
                void act("save-library", save, "Emby selection saved.")
              }
            >
              <Check size={14} />
              Save selection
            </button>
            <button
              className="button secondary"
              disabled={
                Boolean(busy) ||
                showsLoading ||
                showsLibrary !== settings.embyLibraryId ||
                !settings.embyLibraryId
              }
              onClick={() =>
                void act("inspect", async () => {
                  setCandidates([]);
                  setInspected(false);
                  await save();
                  setCandidates(await request("/api/admin/emby/candidates"));
                  setInspected(true);
                })
              }
            >
              <Search size={14} />
              Inspect episodes
            </button>
          </div>
          {inspected && candidates.length === 0 && (
            <p className="field-hint" role="status">
              No episodes found in this selection. Choose another TV show or
              library.
            </p>
          )}
          {candidates.length > 0 && (
            <>
              <div className="settings-divider" />
              <div className="card-heading">
                <div>
                  <h2>Review suggestions</h2>
                  <p>
                    Best guesses use episode titles, folder and file names for
                    the year, venue and session. Review them before saving;
                    ambiguous matches need a manual choice.
                  </p>
                </div>
                <button
                  className="button primary"
                  disabled={Boolean(busy) || !suggestions.length}
                  onClick={() =>
                    void act(
                      "map-all",
                      () =>
                        post(
                          "/api/admin/emby/mappings",
                          suggestions.map((candidate) => ({
                            eventId: candidate.candidates[0].eventId,
                            session: candidate.candidates[0].session,
                            itemId: candidate.itemId,
                            itemName: candidate.name,
                          })),
                        ).catch((error) => {
                          throw error;
                        }),
                      "Suggested mappings saved.",
                    )
                  }
                >
                  <Check size={14} />
                  Save {suggestions.length} suggestions
                </button>
              </div>
              <label className="field">
                Find an episode
                <input
                  value={episodeSearch}
                  onChange={(event) => setEpisodeSearch(event.target.value)}
                  placeholder="Search episode names…"
                />
              </label>
              <div className="mapping-list">
                {candidates
                  .filter((candidate) =>
                    `${candidate.name} ${candidate.path}`
                      .toLowerCase()
                      .includes(episodeSearch.toLowerCase()),
                  )
                  .slice(0, 100)
                  .map((candidate) => (
                    <MappingRow
                      key={candidate.itemId}
                      candidate={candidate}
                      events={weekends}
                      mapped={status.mappings.some(
                        (mapping) => mapping.itemId === candidate.itemId,
                      )}
                      save={(eventId, session) =>
                        void act(
                          "map",
                          () =>
                            post("/api/admin/emby/mappings", [
                              {
                                eventId,
                                session,
                                itemId: candidate.itemId,
                                itemName: candidate.name,
                              },
                            ]),
                          "Episode mapping saved.",
                        )
                      }
                    />
                  ))}
              </div>
              <p className="field-hint">
                Showing up to 100 matching episodes. Use search to narrow the
                list.
              </p>
            </>
          )}
          <div className="settings-divider" />
          <h2>
            Confirmed mappings{" "}
            <span className="muted">({status.mappings.length})</span>
          </h2>
          {status.mappings.length === 0 ? (
            <p className="field-hint">
              Inspect your episodes above to map your collection.
            </p>
          ) : (
            <div className="confirmed-mappings">
              {status.mappings.map((mapping) => (
                <div
                  className="confirmed-row"
                  key={`${mapping.eventId}-${mapping.session}`}
                >
                  <div>
                    <strong>{mapping.itemName}</strong>
                    <span>
                      {mapping.eventId} · {sessions[mapping.session]}
                    </span>
                    {mapping.error ? (
                      <span className="error-text">{mapping.error}</span>
                    ) : (
                      <span>
                        {mapping.lastSyncedAt
                          ? `Updated ${timestamp(mapping.lastSyncedAt)}`
                          : "Waiting for first update"}
                      </span>
                    )}
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Remove mapping for ${mapping.itemName}`}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void act(
                        "remove",
                        () =>
                          request(
                            `/api/admin/emby/mappings/${encodeURIComponent(mapping.eventId)}/${mapping.session}`,
                            { method: "DELETE" },
                          ),
                        "Mapping removed.",
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "activity" && (
        <section className="settings-card">
          <div className="card-heading">
            <div className="card-icon">
              <Clock3 size={19} />
            </div>
            <div>
              <h2>Library activity</h2>
              <p>Calendar checks, background generation, and Emby updates.</p>
            </div>
          </div>
          {status.jobs.length === 0 && (
            <p className="field-hint">
              No tasks yet. Start a calendar sync from Settings.
            </p>
          )}
          {status.jobs.map((job) => (
            <div className="job-row" key={job.id}>
              <div className={`job-icon ${job.status}`}>
                {job.status === "running" ? (
                  <LoaderCircle className="spin" size={18} />
                ) : job.status === "failed" ? (
                  <X size={18} />
                ) : job.status === "completed" ? (
                  <Check size={18} />
                ) : (
                  <Clock3 size={18} />
                )}
              </div>
              <div>
                <strong>
                  {job.kind === "generate"
                    ? "Background generation"
                    : job.kind === "emby"
                      ? "Emby artwork update"
                      : "Calendar sync"}
                  {job.eventId && <span> · {job.eventId}</span>}
                </strong>
                <p>{job.message}</p>
                <span className="field-hint">{timestamp(job.createdAt)}</span>
              </div>
              <Badge tone={job.status === "failed" ? "failure" : ""}>
                {job.status}
              </Badge>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
function MappingRow({
  candidate,
  events,
  mapped,
  save,
}: {
  candidate: EmbyCandidate;
  events: LibraryEvent[];
  mapped: boolean;
  save: (eventId: string, session: SessionKey) => void;
}) {
  const suggestion =
    candidate.candidates.length === 1 ? candidate.candidates[0] : null;
  const [eventId, setEventId] = useState(suggestion?.eventId || "");
  const [session, setSession] = useState<SessionKey>(
    suggestion?.session || "race",
  );
  const selected = events.find((event) => event.id === eventId);
  return (
    <div className="mapping-row">
      <div>
        <strong>{candidate.name}</strong>
        <span title={candidate.path}>
          {candidate.path || `Emby item ${candidate.itemId}`}
        </span>
      </div>
      <select
        aria-label={`Weekend for ${candidate.name}`}
        value={eventId}
        onChange={(event) => setEventId(event.target.value)}
      >
        <option value="">Choose weekend</option>
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.season} · {raceLabel(event)}
          </option>
        ))}
      </select>
      <select
        aria-label={`Session for ${candidate.name}`}
        value={session}
        onChange={(event) => setSession(event.target.value as SessionKey)}
      >
        {(
          selected?.images || [
            { session: "race", label: "Race" },
            { session: "qualifying", label: "Qualifying" },
          ]
        ).map((image) => (
          <option key={image.session} value={image.session}>
            {image.label}
          </option>
        ))}
      </select>
      {mapped ? (
        <Badge tone="connected">
          <Check size={12} />
          Mapped
        </Badge>
      ) : (
        <button
          className="button secondary"
          disabled={
            !selected ||
            !selected.images.some((image) => image.session === session)
          }
          onClick={() => save(eventId, session)}
        >
          Save
        </button>
      )}
    </div>
  );
}
