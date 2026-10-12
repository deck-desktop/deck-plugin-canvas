// Canvas, which was Deck's built-in Pinboard until 1.1.
//
// A per-project junk drawer: sketch, notes, screenshots, links and one-click commands for the
// checkout you're in. Scoped by the workspace's FOLDER, not its id — a workspace is a window
// onto a project, and closing one shouldn't take the drawer with it.
//
// Excalidraw IS the board. Drawing, shapes, arrows, text, images, select/move, undo and its own
// pan/zoom all come from it; the only thing the library has no concept of is a button that DOES
// something, so those are embeddable elements carrying a deck:// link, rendered by
// renderEmbeddable as real React. Creating them from the toolbar was removed as unused; the
// ones already on a board still resolve and run. A hand-rolled canvas here was replaced wholesale: once "real
// sketching" became a requirement, reimplementing a drawing app beside one already in the
// dependency tree stopped making sense.
//
// Device-local and per project: a board is full of this machine's paths and shell commands.
//
// Boards saved by the Pinboard are `pinboard-<project>.json`; Deck renames them to
// `canvas-<project>.json` at startup (config::rename_pinboards), so they are here unchanged.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { TabStrip, ConfirmDialog, NamePrompt, type ConfirmState, type NamePromptState } from "../shim/ui.js";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import excalidrawCss from "@excalidraw/excalidraw/index.css";
import { TerminalSquare, FileCog, ExternalLink, Loader2 } from "lucide-react";
import {
  configRead, configWrite, openExternal, openFile, runScriptNow, type ScriptJob,
} from "../shim/bridge.js";

// Excalidraw's stylesheet, and Deck's colours over it. A plugin is one plugin.js, so the CSS
// arrives as text (the builder's .css loader) and goes in as a <style>, taken out again on dispose.
//
// The colours: only Excalidraw's theme variables are swapped, so every surface (toolbar, menus,
// the zoom and undo islands, dialogs) follows at once. The canvas itself is drawn transparent
// (see viewBackgroundColor below), so the pane's background shows through as for any other pane.
const DECK_THEME = `
.deck-canvas .excalidraw.theme--dark {
  --island-bg-color: var(--bg-elev);
  --sidebar-bg-color: var(--bg-elev);
  --popup-bg-color: var(--bg-elev);
  --input-bg-color: var(--bg-app);
  --default-bg-color: var(--bg-app);
  --default-border-color: var(--border-subtle);
  --color-surface-low: var(--bg-elev);
  --color-surface-mid: var(--bg-hover);
  --color-surface-high: var(--bg-hover);
  --button-gray-1: var(--bg-hover);
  --color-primary: var(--accent);
  --color-primary-darker: var(--accent);
  --color-primary-light: var(--accent-soft);
  --color-surface-primary-container: var(--accent-soft);
  --color-on-primary-container: var(--accent);
  --shadow-island: none;
  --ui-font: var(--font-sans);
}
.deck-canvas .excalidraw .Island { border: 1px solid var(--border-subtle); }
`;
const style = document.createElement("style");
style.dataset.plugin = "canvas";
style.textContent = excalidrawCss + DECK_THEME;
document.head.appendChild(style);
export function dispose() { style.remove(); }

/** Folder-derived key, so the drawer follows the project rather than a workspace uuid. */
const projectKey = (cwd: string) =>
  `canvas-${(cwd || "home").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")}`;

/**
 * A project's boards, in tab order, in `<project>-boards`.
 *
 * The first board's id is "" and it is stored under the project key itself, which is where the
 * one board a project had before there could be several already lives: it needs no migration.
 * Every other board is `<project>_<id>` (a project key never holds "_"). No list on disk means
 * the project has only that first board.
 */
interface BoardRef { id: string; name: string }
const boardsKey = (project: string) => `${project}-boards`;
const sceneKey = (project: string, id: string) => (id ? `${project}_${id}` : project);
const DEFAULT_BOARDS: BoardRef[] = [{ id: "", name: "Board" }];
const newId = () => Math.random().toString(36).slice(2, 10);

/** Which board was open in each project, kept across mounts, like Notes does for its notes. */
const lastBoard = new Map<string, string>();

/**
 * Pictures live in their own file, `<key>-files`, beside the scene.
 *
 * They used to be inside the scene, as data URLs, so a board with a few screenshots was 13.8MB:
 * re-serialised on every pointer move while drawing (to see whether anything changed) and rewritten
 * 800ms after every stroke. The scene alone is a few kilobytes; pictures change only when one is
 * added, and only then is their file written. A board saved the old way still loads: its pictures
 * are moved to the new file first, before the scene is next saved without them.
 */
const filesKey = (key: string) => `${key}-files`;

type ButtonAction = "term" | "script" | "open";
/** A button is an embeddable whose link encodes what it does — the scene stays plain JSON. */
const BUTTON_LINK = /^deck:\/\/(term|script|open)\/(.*)$/;
const decodeButton = (link: string): { action: ButtonAction; arg: string } | null => {
  const m = BUTTON_LINK.exec(link || "");
  return m ? { action: m[1] as ButtonAction, arg: decodeURIComponent(m[2]) } : null;
};

/** A URL goes to the browser; anything else is a path for the OS default handler. */
const openOne = (target: string) =>
  /^[a-z]+:\/\//i.test(target) ? openExternal(target).catch(() => {}) : openFile(target).catch(() => {});

// A pane view only: boards belong to a workspace's folder, which a pane is given.
export function PaneView({ cwd, runInTerminal }: {
  cwd: string;
  /** Opens a NEW tab and types the command — never the active pane, which may be running an agent. */
  runInTerminal: (label: string, command: string) => void;
}) {
  const project = projectKey(cwd);
  const [boards, setBoards] = useState<BoardRef[] | null>(null);
  const [active, setActive] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [renaming, setRenaming] = useState<NamePromptState | null>(null);

  useEffect(() => {
    let alive = true;
    setBoards(null);
    configRead(boardsKey(project)).then((t) => {
      if (!alive) return;
      const list: BoardRef[] = t.trim() ? JSON.parse(t) : DEFAULT_BOARDS;
      const want = lastBoard.get(project);
      setBoards(list.length ? list : DEFAULT_BOARDS);
      setActive(want !== undefined && list.some((b) => b.id === want) ? want : list[0]?.id ?? "");
    }).catch(() => { if (alive) { setBoards(DEFAULT_BOARDS); setActive(""); } });
    return () => { alive = false; };
  }, [project]);

  const save = (next: BoardRef[]) => {
    setBoards(next);
    void configWrite(boardsKey(project), JSON.stringify(next)).catch(() => {});
  };
  const open = (id: string) => { lastBoard.set(project, id); setActive(id); };

  if (!boards) return <Loading />;

  const add = () => {
    let name = "Board";
    for (let n = 2; boards.some((b) => b.name === name); n++) name = `Board ${n}`;
    const b = { id: newId(), name };
    save([...boards, b]);
    open(b.id);
  };

  const remove = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    setConfirm({
      title: `Delete "${b.name}"?`,
      body: "The drawing and its pictures are deleted from this machine.",
      confirmLabel: "Delete",
      onConfirm: () => {
        // An empty write removes the file (see the config writer in Deck).
        const key = sceneKey(project, id);
        void configWrite(key, "").catch(() => {});
        void configWrite(filesKey(key), "").catch(() => {});
        const rest = boards.filter((x) => x.id !== id);
        // The last board is cleared rather than left as no board at all.
        save(rest.length ? rest : DEFAULT_BOARDS);
        if (id === active) open((rest[0] ?? DEFAULT_BOARDS[0]).id);
      },
    });
  };

  const rename = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    setRenaming({
      title: "Rename board", initial: b.name, confirmLabel: "Rename",
      onSave: (to) => { if (to.trim()) save(boards.map((x) => (x.id === id ? { ...x, name: to.trim() } : x))); },
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
      <TabStrip pill
        tabs={boards.map((b) => ({ id: b.id, title: b.name, closeTitle: "Delete board" }))}
        activeId={active}
        onSelect={open}
        onClose={remove}
        onDoubleClick={rename}
        onReorder={(from, to) => {
          const next = boards.filter((b) => b.id !== from);
          next.splice(boards.findIndex((b) => b.id === to), 0, boards.find((b) => b.id === from)!);
          save(next);
        }}
        onAdd={add} addTitle="New board"
      />
      {/* Keyed by board: Excalidraw reads initialData only when it mounts. */}
      <Board key={sceneKey(project, active)} storeKey={sceneKey(project, active)} runInTerminal={runInTerminal} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <NamePrompt state={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}

const Loading = () => (
  <div className="flex h-full min-w-0 flex-1 items-center justify-center text-sm text-text-muted">
    <Loader2 size={16} className="mr-2 animate-spin" /> Loading…
  </div>
);

/** One board: an Excalidraw scene stored under `storeKey`, its pictures beside it. */
function Board({ storeKey: key, runInTerminal: onRunInTerminal }: {
  storeKey: string;
  runInTerminal: (label: string, command: string) => void;
}) {
  const [initialData, setInitialData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scripts, setScripts] = useState<ScriptJob[]>([]);
  const apiRef = useRef<any>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Last JSON written. serializeAsJSON drops transient appState (scroll/zoom/active tool), so a
  // pure pan or selection serialises identically — without this the save indicator never settles.
  const lastSaved = useRef("");
  // The ids of the pictures already in the files file, so a save writes it only when one is new.
  const savedFileIds = useRef(new Set<string>());
  // The scene waiting on the debounce, so leaving the board (switching tab, closing the pane)
  // writes it at once instead of dropping the last stroke.
  const pending = useRef<string | null>(null);
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    if (pending.current !== null) void configWrite(key, pending.current).catch(() => {});
  }, [key]);

  // Script jobs resolve at CLICK time rather than being baked into the element: renaming or
  // editing a job in Script Runner then propagates, and a deleted one reads as missing instead
  // of running stale arguments.
  const scriptsRef = useRef<ScriptJob[]>([]);
  scriptsRef.current = scripts;
  useEffect(() => {
    configRead("script-runner").then((t) => setScripts(t.trim() ? JSON.parse(t) : [])).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([configRead(key), configRead(filesKey(key)).catch(() => "")]).then(([t, f]) => {
      if (!alive) return;
      const scene = t.trim() ? JSON.parse(t) : { elements: [], appState: {}, files: {} };
      // collaborators must be a Map or absent — persisted junk here breaks Excalidraw's restore.
      const { collaborators: _drop, ...appState } = scene.appState ?? {};
      // Excalidraw's default white page, drawn as its own dark grey in dark mode, is replaced by no
      // page at all so the pane's colour shows through. A colour someone picked is kept.
      if (!appState.viewBackgroundColor || appState.viewBackgroundColor === "#ffffff") appState.viewBackgroundColor = "transparent";
      let files = f.trim() ? JSON.parse(f) : {};
      // Saved the old way, pictures inside the scene: move them to their own file now. Writes
      // land in order, so this is on disk before the scene is next saved without them.
      if (scene.files && Object.keys(scene.files).length) {
        files = { ...scene.files, ...files };
        void configWrite(filesKey(key), JSON.stringify(files)).catch(() => {});
      }
      savedFileIds.current = new Set(Object.keys(files));
      lastSaved.current = serializeAsJSON(scene.elements ?? [], appState, {}, "local");
      setInitialData({
        elements: scene.elements ?? [],
        appState: { ...appState, theme: "dark" },
        files,
        scrollToContent: true,
      });
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setInitialData({ elements: [], appState: { theme: "dark", viewBackgroundColor: "transparent" }, files: {} });
      setLoading(false);
    });
    return () => { alive = false; };
  }, [key]);

  const onChange = (elements: readonly any[], appState: any, files: any) => {
    // Excalidraw gates an embeddable's inner content behind an activation click: the first
    // press only selects the element, so a button needed two clicks to fire. Promoting it to
    // "active" as soon as it is hovered means the press lands on the button itself.
    if (appState?.activeEmbeddable?.state === "hover") {
      const el = appState.activeEmbeddable.element;
      apiRef.current?.updateScene({ appState: { activeEmbeddable: { element: el, state: "active" } } });
    }
    // A new picture: write the pictures file, once. Excalidraw's `files` holds every picture the
    // board has loaded, so this keeps one a deleted element still points at, for undo.
    const ids = Object.keys(files ?? {});
    if (ids.some((id) => !savedFileIds.current.has(id))) {
      savedFileIds.current = new Set(ids);
      void configWrite(filesKey(key), JSON.stringify(files)).catch(() => {});
    }
    // The scene without the pictures: a few kilobytes, so serialising it on every change is cheap.
    const json = serializeAsJSON(elements as any, appState, {}, "local");
    if (json === lastSaved.current) return; // view-only change (pan, zoom, selection)
    clearTimeout(saveTimer.current);
    setSaving(true);
    pending.current = json;
    saveTimer.current = setTimeout(async () => {
      pending.current = null;
      await configWrite(key, json).catch(() => {});
      lastSaved.current = json;
      setSaving(false);
    }, 800);
  };

  const runButton = (action: ButtonAction, arg: string, label: string) => {
    if (action === "term") { onRunInTerminal(label, arg); return; }
    if (action === "open") { void openOne(arg); return; }
    const job = scriptsRef.current.find((j) => j.id === arg);
    if (job) void runScriptNow(job.command, job.args, job.id, job.name);
  };

  if (loading || !initialData) return <Loading />;

  // Excalidraw caches where its box sits on screen and re-reads it only when the window or the
  // box RESIZES. A zone or tab switch moves the pane without resizing it, so every click and drag
  // then landed at the old position. Comparing on each pointer move costs one rect read, and the
  // refresh (a re-render) only runs when the position actually changed — before any press lands.
  const syncOffsets = (e: PointerEvent<HTMLDivElement>) => {
    const api = apiRef.current;
    const box = e.currentTarget.querySelector(".excalidraw")?.getBoundingClientRect();
    if (!api || !box) return;
    const st = api.getAppState();
    if (box.left !== st.offsetLeft || box.top !== st.offsetTop) api.refresh();
  };

  return (
    <div className="deck-canvas relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      onPointerMoveCapture={syncOffsets} onPointerEnter={syncOffsets}>
      <Excalidraw
        initialData={initialData}
        onChange={onChange}
        onExcalidrawAPI={(api: any) => { apiRef.current = api; }}
        // Our own button scheme, plus any https URL. Returning only deck:// here was what
        // produced "Embedding this url is currently not allowed" — that message is this
        // validator refusing the link, not a limitation of the library. Excalidraw's built-in
        // allowlist (YouTube, Figma, …) still applies to anything this does not claim.
        validateEmbeddable={(link: string) => BUTTON_LINK.test(link) || /^https:\/\//i.test(link)}
        renderEmbeddable={(el: any) => {
          const spec = decodeButton(el?.link ?? "");
          if (!spec) return null;
          return (
            <DeckButton
              label={el?.customData?.deckLabel ?? spec.arg}
              action={spec.action}
              arg={spec.arg}
              scripts={scripts}
              onRun={runButton}
            />
          );
        }}
        UIOptions={{
          canvasActions: {
            // A board is per-project and autosaved; loading someone else's scene over it or
            // wiping it from a menu are not things that should be one click away.
            loadScene: false, saveAsImage: false, export: false, clearCanvas: false,
          },
        }}
      />

      {/* The Link and Button entries that used to sit here were removed as unused. Buttons
          already on a board still work — runButton, decodeButton and AddButtonForm are all
          intact — there is simply no toolbar entry creating new ones. */}
      {saving && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <span className="rounded-lg border border-subtle px-2.5 py-1.5 text-[10px] text-text-muted"
            style={{ background: "var(--bg-app)" }}>saving…</span>
        </div>
      )}
    </div>
  );
}

/** The live control inside an embeddable element. */
function DeckButton({ label, action, arg, scripts, onRun }: {
  label: string; action: ButtonAction; arg: string; scripts: ScriptJob[];
  onRun: (action: ButtonAction, arg: string, label: string) => void;
}) {
  const missing = action === "script" && !scripts.some((j) => j.id === arg);
  const Icon = action === "term" ? TerminalSquare : action === "script" ? FileCog : ExternalLink;
  const sub = missing ? "missing script"
    : action === "script" ? scripts.find((j) => j.id === arg)?.name ?? arg
    : arg;
  return (
    <button
      onClick={() => !missing && onRun(action, arg, label)}
      disabled={missing}
      title={missing ? "That script no longer exists in Script Runner" : arg}
      className="flex h-full w-full items-center gap-2 rounded-lg border border-subtle px-3 text-left text-[12px] transition-colors hover:bg-white/5 disabled:opacity-50"
      style={{ background: "var(--bg-card-glass)" }}
    >
      <Icon size={13} className="shrink-0 text-text-muted" />
      <span className="min-w-0">
        <span className="block truncate font-medium text-text-primary">{label}</span>
        <span className="block truncate text-[10px] text-text-muted">{sub}</span>
      </span>
    </button>
  );
}
