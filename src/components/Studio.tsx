import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ImagePlus,
  Link2,
  LoaderCircle,
  MessageSquareText,
  Palette,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink2,
  Upload,
  X,
} from "lucide-react";
import {
  errorMessage,
  post,
  put,
  readDataUrl,
  remove,
  request,
} from "../lib/api";
import {
  overlayElements,
  resolveColour,
  sessions,
  type Job,
  type OverlayColours,
  type OverlayElement,
  type SessionKey,
  type StudioState,
  type StudioVersion,
} from "../../shared/types.ts";

const elements = Object.keys(overlayElements) as OverlayElement[];
const sourceLabel: Record<StudioVersion["source"], string> = {
  current: "Original",
  generate: "Fresh generation",
  feedback: "Feedback",
  upload: "Uploaded",
};
const active = (job: Job | null) =>
  job?.status === "queued" || job?.status === "running";
const snapshot = (selected: string | null, colours: OverlayColours | null) =>
  JSON.stringify({ selected, colours });

// The composed thumbnail: background plus the same vector overlay the
// renderer draws, so colour changes preview instantly and exactly.
function Preview({
  state,
  image,
  colours,
  session,
}: {
  state: StudioState;
  image: string | null;
  colours: OverlayColours;
  session: SessionKey;
}) {
  const fill = (element: OverlayElement) =>
    resolveColour(colours, element, session);
  const { logo } = state.overlay;
  const logoFill = fill("logo");
  const logoHref = useMemo(
    () =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo.svg.replace(/fill="[^"]*"/g, `fill="${logoFill}"`))}`,
    [logo.svg, logoFill],
  );
  const glyphs = (
    items: StudioState["overlay"]["title"] | undefined,
    element: OverlayElement,
  ) =>
    items?.map((glyph, index) => (
      <path
        key={index}
        fill={fill(element)}
        transform={glyph.transform}
        d={glyph.d}
      />
    ));
  return (
    <svg
      className="studio-preview"
      viewBox="0 0 1920 1080"
      role="img"
      aria-label={`${state.event.displayName} ${sessions[session]} thumbnail preview`}
    >
      {image ? (
        <image
          href={image}
          width="1920"
          height="1080"
          preserveAspectRatio="xMidYMid slice"
        />
      ) : (
        <>
          <rect width="1920" height="1080" fill="#172322" />
          <text
            x="960"
            y="630"
            textAnchor="middle"
            fontSize="36"
            fill="#b5c1ba"
          >
            No background yet
          </text>
        </>
      )}
      <image
        x={logo.x}
        y={logo.y}
        width={logo.width}
        height={logo.height}
        href={logoHref}
      />
      {glyphs(state.overlay.title, "title")}
      {glyphs(state.overlay.sessions[session], "session")}
      {glyphs(state.overlay.round, "round")}
    </svg>
  );
}

function ColourField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <span className="colour-field">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        className="colour-hex"
        aria-label={`${label} hex`}
        value={text}
        maxLength={7}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          if (/^#[0-9a-f]{6}$/i.test(event.target.value))
            onChange(event.target.value.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </span>
  );
}

export function Studio({
  eventId,
  onBack,
  notify,
}: {
  eventId: string;
  onBack: () => void;
  notify: (text: string) => void;
}) {
  const base = `/api/admin/studio/${encodeURIComponent(eventId)}`;
  const [state, setState] = useState<StudioState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [colours, setColours] = useState<OverlayColours | null>(null);
  const [session, setSession] = useState<SessionKey>("race");
  const [feedback, setFeedback] = useState("");
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The last draft known to the server; local edits differing from it are saved.
  const saved = useRef("");
  const watched = useRef<string | null>(null);

  // Take the shared draft (or the live thumbnail) as the editing state.
  const adopt = useCallback((next: StudioState) => {
    const live = next.versions.find((version) => version.live);
    const choice =
      next.draft?.selectedVersionId ??
      live?.id ??
      next.versions.at(-1)?.id ??
      null;
    const chosen = next.draft?.colours ?? next.approvedColours;
    setState(next);
    setSelected(choice);
    setColours(chosen);
    setSession((current) =>
      next.sessions.includes(current) ? current : next.sessions.at(-1)!,
    );
    saved.current = snapshot(choice, chosen);
  }, []);
  const load = useCallback(
    () => request<StudioState>(base).then(adopt),
    [adopt, base],
  );
  useEffect(() => {
    void load().catch((error) => setError(errorMessage(error)));
  }, [load]);

  // While an image request runs, follow it; the result becomes the selection.
  const running = active(state?.job ?? null);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void request<StudioState>(base)
        .then((next) => {
          if (active(next.job)) setState(next);
          else {
            if (
              next.job?.status === "failed" &&
              next.job.id === watched.current
            )
              setError(next.job.message);
            else if (next.job?.status === "completed")
              notify("New version ready. It stays a draft until you use it.");
            watched.current = null;
            adopt(next);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [adopt, base, notify, running]);

  // Draft changes are saved as you go; the last write wins.
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveDraft = useCallback(async () => {
    clearTimeout(pending.current);
    const current = snapshot(selected, colours);
    if (!colours || current === saved.current) return;
    saved.current = current;
    await put(`${base}/draft`, { selectedVersionId: selected, colours });
  }, [base, colours, selected]);
  useEffect(() => {
    if (!state || !colours) return;
    clearTimeout(pending.current);
    pending.current = setTimeout(
      () => void saveDraft().catch((error) => setError(errorMessage(error))),
      500,
    );
    return () => clearTimeout(pending.current);
  }, [colours, saveDraft, selected, state]);

  const act = async (name: string, task: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await task();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  if (!state || !colours)
    return (
      <main className="admin-main">
        {error ? (
          <div className="alert error" role="alert">
            {error}
            <button onClick={onBack}>Back to workspace</button>
          </div>
        ) : (
          <div className="library-loading">
            <LoaderCircle className="spin" />
            Opening the studio…
          </div>
        )}
      </main>
    );

  const version = state.versions.find((item) => item.id === selected) ?? null;
  const live = state.versions.find((item) => item.live) ?? null;
  const remaining = Math.max(0, state.allowance.limit - state.allowance.used);
  const coloursChanged =
    JSON.stringify(colours) !== JSON.stringify(state.approvedColours);
  const changed = selected !== (live?.id ?? null) || coloursChanged;
  const blocked = !state.generation.ready
    ? state.generation.reason
    : remaining === 0
      ? "No generation attempts left this month. Raise the allowance in Settings or wait until next month. Colours and earlier versions still work."
      : "";
  const canRequest = !blocked && !running && !busy;
  const setElement = (
    element: OverlayElement,
    value: OverlayColours[OverlayElement],
  ) => setColours({ ...colours, [element]: value });
  const toggleLink = (element: OverlayElement) => {
    const setting = colours[element];
    setElement(
      element,
      setting.linked
        ? {
            linked: false,
            colour: setting.colour,
            sessions: Object.fromEntries(
              state.sessions.map((key) => [key, setting.colour]),
            ),
          }
        : {
            linked: true,
            colour: resolveColour(colours, element, session),
            sessions: {},
          },
    );
  };
  const requestImage = (body: Record<string, string>) =>
    act("generate", async () => {
      await saveDraft();
      const job = await post<Job>(`${base}/generate`, body);
      watched.current = job.id;
      setFeedback("");
      setState((current) => current && { ...current, job });
    });

  return (
    <main className="admin-main studio">
      <div className="studio-heading">
        <button
          className="button secondary"
          onClick={() =>
            void saveDraft()
              .catch(() => {})
              .finally(onBack)
          }
        >
          <ArrowLeft size={14} />
          Back to workspace
        </button>
        <div>
          <div className="eyebrow">IMAGE STUDIO</div>
          <h1>
            {state.event.season} · R{state.event.round} ·{" "}
            {state.event.displayName}
          </h1>
          <p>
            {state.event.circuit}, {state.event.locality}, {state.event.country}
          </p>
        </div>
        <span className={`badge ${changed ? "" : "connected"}`}>
          {changed ? "Draft" : "Live"}
        </span>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={15} />
          </button>
        </div>
      )}
      <div className="studio-layout">
        <section className="studio-stage">
          <div className="studio-canvas">
            <Preview
              state={state}
              image={version?.preview ?? null}
              colours={colours}
              session={session}
            />
            {running && (
              <div className="studio-working" role="status">
                <LoaderCircle className="spin" size={18} />
                {state.job?.status === "queued"
                  ? "Waiting for the image queue…"
                  : "Painting a new version…"}
              </div>
            )}
          </div>
          <div className="studio-sessions" role="group" aria-label="Session">
            {state.sessions.map((key) => (
              <button
                key={key}
                className={key === session ? "selected" : ""}
                aria-pressed={key === session}
                onClick={() => setSession(key)}
              >
                {sessions[key]}
              </button>
            ))}
          </div>
          <h2 className="studio-label">Versions</h2>
          {state.versions.length ? (
            <div className="studio-versions">
              {state.versions
                .slice()
                .reverse()
                .map((item) => (
                  <button
                    key={item.id}
                    className={item.id === selected ? "selected" : ""}
                    aria-pressed={item.id === selected}
                    aria-label={`Version ${item.number}`}
                    onClick={() => setSelected(item.id)}
                  >
                    <img src={item.thumbnail} alt="" loading="lazy" />
                    <span>
                      <strong>
                        #{item.number} · {sourceLabel[item.source]}
                      </strong>
                      {item.live && <em>Live</em>}
                    </span>
                    {item.feedback && <small>{item.feedback}</small>}
                  </button>
                ))}
            </div>
          ) : (
            <p className="field-hint">
              No versions yet. Generate a fresh image or upload your own.
            </p>
          )}
        </section>
        <aside className="studio-panel">
          <section className="settings-card">
            <div className="card-heading">
              <div className="card-icon">
                <MessageSquareText size={19} />
              </div>
              <div>
                <h2>Image</h2>
                <p>
                  {remaining} of {state.allowance.limit} attempts left this
                  month. Each request uses one.
                </p>
              </div>
            </div>
            {blocked && <div className="alert">{blocked}</div>}
            {!blocked && !state.generation.referenceImages && (
              <div className="alert">
                The selected model can't take a reference image, so feedback
                revisions are unavailable. Fresh generation still works.
              </div>
            )}
            <label className="field">
              Feedback on version {version ? `#${version.number}` : "—"}
              <textarea
                rows={3}
                maxLength={1000}
                placeholder="e.g. Change the car colour to pink"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={
                !canRequest ||
                !version ||
                !feedback.trim() ||
                !state.generation.referenceImages
              }
              onClick={() =>
                void requestImage({
                  feedback: feedback.trim(),
                  baseVersionId: version!.id,
                })
              }
            >
              {busy === "generate" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Sparkles size={14} />
              )}
              Send feedback
            </button>
            <div className="settings-divider" />
            <label className="field">
              Extra direction for a fresh image (optional)
              <textarea
                rows={2}
                maxLength={1000}
                placeholder="e.g. Feature the most recognisable landmark"
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={!canRequest}
                onClick={() =>
                  void requestImage(
                    direction.trim() ? { direction: direction.trim() } : {},
                  )
                }
              >
                <ImagePlus size={14} />
                Generate fresh
              </button>
              <label
                className={`button secondary upload-button ${busy || running ? "disabled" : ""}`}
              >
                <Upload size={14} />
                Upload image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={Boolean(busy) || running}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (file.size > 20 * 1024 * 1024) {
                      setError("Choose an image smaller than 20 MB.");
                      return;
                    }
                    void act("upload", async () => {
                      await saveDraft();
                      adopt(
                        await post<StudioState>(`${base}/upload`, {
                          image: await readDataUrl(file),
                        }),
                      );
                    });
                  }}
                />
              </label>
            </div>
          </section>
          <section className="settings-card">
            <div className="card-heading">
              <div className="card-icon">
                <Palette size={19} />
              </div>
              <div>
                <h2>Overlay colours</h2>
                <p>Linked colours apply to every session.</p>
              </div>
              <button
                className="icon-button"
                disabled={
                  JSON.stringify(colours) ===
                  JSON.stringify(state.defaultColours)
                }
                onClick={() => setColours(state.defaultColours)}
                aria-label="Reset colours to default"
                title="Reset colours to default"
              >
                <RotateCcw size={16} />
              </button>
            </div>
            {elements.map((element) => {
              const setting = colours[element];
              const label = overlayElements[element];
              return (
                <div className="colour-row" key={element}>
                  <div className="colour-heading">
                    <strong>{label}</strong>
                    {setting.linked && (
                      <ColourField
                        label={`${label} colour`}
                        value={setting.colour}
                        onChange={(value) =>
                          setElement(element, { ...setting, colour: value })
                        }
                      />
                    )}
                    <button
                      className={`icon-button link-toggle ${setting.linked ? "linked" : ""}`}
                      aria-pressed={setting.linked}
                      aria-label={`Link ${label} colour across sessions`}
                      title={
                        setting.linked
                          ? "Linked across sessions — click to set per session"
                          : "Per session — click to link"
                      }
                      onClick={() => toggleLink(element)}
                    >
                      {setting.linked ? (
                        <Link2 size={16} />
                      ) : (
                        <Unlink2 size={16} />
                      )}
                    </button>
                  </div>
                  {!setting.linked && (
                    <div className="colour-sessions">
                      {state.sessions.map((key) => (
                        <label key={key}>
                          <span>{sessions[key]}</span>
                          <ColourField
                            label={`${label} colour for ${sessions[key]}`}
                            value={resolveColour(colours, element, key)}
                            onChange={(value) => {
                              setSession(key);
                              setElement(element, {
                                ...setting,
                                sessions: { ...setting.sessions, [key]: value },
                              });
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
          <div className="studio-actions">
            <button
              className="button primary"
              disabled={Boolean(busy) || running || !changed}
              onClick={() =>
                void act("approve", async () => {
                  clearTimeout(pending.current);
                  adopt(
                    await post<StudioState>(`${base}/approve`, {
                      versionId: selected,
                      colours,
                    }),
                  );
                  notify(
                    `Thumbnail applied to all ${state.sessions.length} sessions. Emby will update shortly.`,
                  );
                })
              }
            >
              {busy === "approve" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Check size={14} />
              )}
              Use this thumbnail
            </button>
            <button
              className="button secondary"
              disabled={Boolean(busy) || (!state.draft && !changed)}
              onClick={() =>
                void act("discard", async () => {
                  clearTimeout(pending.current);
                  adopt(await remove<StudioState>(`${base}/draft`));
                  notify("Draft discarded. The live thumbnail is unchanged.");
                })
              }
            >
              <Trash2 size={14} />
              Discard draft
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
