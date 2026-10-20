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
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { TabStrip, ConfirmDialog, NamePrompt, ContextMenu, type ConfirmState, type NamePromptState, type MenuEntry } from "../shim/ui.js";
import { Excalidraw, Footer, serializeAsJSON } from "@excalidraw/excalidraw";
import excalidrawCss from "@excalidraw/excalidraw/index.css";
import { TerminalSquare, FileCog, ExternalLink, Loader2, Share2, LogIn, Copy, Check, Pencil, Trash2, UserX, UserPlus, Grid3x3, Magnet } from "lucide-react";
import { cleanCode, newCode, type Mode, type Person, type Roles } from "../shim/p2p.js";
import { LiveShare, type LiveView, type Share } from "./live";

import {
  configRead, configWrite, openExternal, openFile, runScriptNow, type ScriptJob,
} from "../shim/bridge.js";
import { userName } from "../shim/settings.js";

// Excalidraw's stylesheet, and Deck's colours over it. A plugin is one plugin.js, so the CSS
// arrives as text (the builder's .css loader) and goes in as a <style>, taken out again on dispose.
//
// The colours: only Excalidraw's theme variables are swapped, so every surface (toolbar, menus,
// the zoom and undo islands, dialogs) follows at once. The canvas itself is drawn transparent
// (see viewBackgroundColor below), so the pane's background shows through as for any other pane.
const DECK_THEME = `
.deck-canvas .excalidraw.theme--dark,
.deck-canvas .excalidraw.theme--light {
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
/* The grid button at the top right, drawn like the toolbar's own buttons. */
.deck-canvas .deck-grid-toggle {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px;
  border: 1px solid var(--border-subtle); background: var(--bg-elev); color: var(--text-secondary);
  cursor: pointer;
}
.deck-canvas .deck-grid-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
.deck-canvas .deck-grid-toggle[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.deck-canvas .deck-grid-toggle:disabled { opacity: 0.4; cursor: default; }
/* The grid: fine lines every grid square, stronger ones every fifth, positioned with the scene. */
.deck-canvas .deck-grid {
  --grid-major: color-mix(in srgb, var(--text-primary) 12%, transparent);
  background-image:
    linear-gradient(to right, var(--grid-major) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid-major) 1px, transparent 1px),
    linear-gradient(to right, var(--grid-minor, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid-minor, transparent) 1px, transparent 1px);
  background-size:
    var(--grid-major-size, 100px) var(--grid-major-size, 100px), var(--grid-major-size, 100px) var(--grid-major-size, 100px),
    var(--grid-minor-size, 20px) var(--grid-minor-size, 20px), var(--grid-minor-size, 20px) var(--grid-minor-size, 20px);
  background-position: var(--grid-x, 0) var(--grid-y, 0);
}
/* The share controls, in the footer row beside zoom and undo, drawn the way those are: a
   panel of borderless buttons (not an .Island, which Deck draws with a border the zoom and undo
   panels do not have) the height of Excalidraw's large buttons. */
.deck-canvas .deck-share { display: flex; align-items: center; height: var(--lg-button-size); overflow: hidden;
  background: var(--island-bg-color); border-radius: var(--border-radius-lg);
  font-family: var(--ui-font); font-size: .875rem; color: var(--text-primary-color); }
.deck-canvas .deck-share > button { display: flex; align-items: center; gap: .4rem; height: 100%; padding: 0 .75rem;
  border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.deck-canvas .deck-share > button:hover { background: var(--button-hover-bg); }
.deck-canvas .deck-share > button svg, .deck-canvas .deck-share-text svg { width: var(--lg-icon-size); height: var(--lg-icon-size); }
.deck-canvas .deck-share > .deck-share-text { display: flex; align-items: center; gap: .5rem; padding: 0 .75rem; color: var(--color-gray-50, inherit); white-space: nowrap; }
/* Someone asking to join: outlined in the accent, so it is noticed. */
.deck-canvas .deck-knock { box-shadow: 0 0 0 1px var(--color-primary) inset; }
/* The same gap Excalidraw leaves between its zoom and undo islands. */
.deck-canvas .deck-share-row { display: flex; gap: .6em; align-items: center; margin-inline-start: .6em; }
`;
const style = document.createElement("style");
style.dataset.plugin = "canvas";
style.textContent = excalidrawCss + DECK_THEME;
document.head.appendChild(style);
export function dispose() {
  style.remove();
  // A reload re-imports the plugin: the old copy's shares end here rather than run on unseen.
  for (const l of lives.values()) void l.close();
  lives.clear();
}

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
 * The share each project was last in. A host who opens another of its boards ends that share, and
 * coming back offers Resume sharing in one click instead of typing the code again.
 * (Leaving the Canvas tab does not end a share at all: see `lives`.) Memory only, never written
 * to disk, gone when Deck restarts; cleared when a share is ended on purpose (Stop, Leave, Close).
 */
const remembered = new Map<string, Share & { board: string }>();

/**
 * The live share of each project, kept while the Canvas tab is off screen (see live.ts): switching
 * tab or workspace no longer ends it. Ended on purpose only: Stop, Leave, Close.
 */
const lives = new Map<string, LiveShare>();


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

/**
 * The board as it was when sharing started, in `<key>-share-backup`, so that when sharing ends the
 * host can keep what was drawn together or go back. On disk rather than in memory: if Deck closes
 * mid-share, the board offers the same choice the next time it opens.
 */
const backupKey = (key: string) => `${key}-share-backup`;
interface Backup { scene: string; files: string; at: number }

/** The attribute TabStrip puts on each tab (for drag-reordering), read here to know which tab
 *  was right-clicked without a change to TabStrip itself. */
const TAB_ATTR = "data-drag-id";

type ButtonAction = "term" | "script" | "open";
/** A button is an embeddable whose link encodes what it does — the scene stays plain JSON. */
const BUTTON_LINK = /^deck:\/\/(term|script|open)\/(.*)$/;
const decodeButton = (link: string): { action: ButtonAction; arg: string } | null => {
  const m = BUTTON_LINK.exec(link || "");
  return m ? { action: m[1] as ButtonAction, arg: decodeURIComponent(m[2]) } : null;
};

/** A URL goes to the browser; anything else is a path for the OS default handler. */
const openOne = (target: string) =>
  /^[a-z]+:\/\//i.test(target) ? openExternal(target).catch((e) => console.warn("[canvas] open link failed", e)) : openFile(target).catch((e) => console.warn("[canvas] open file failed", e));

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
  // A live share: hosting this board, or a guest on someone else's. A guest's board is theirs, not
  // this project's, so it is shown in place of the local one and never saved over it.
  // A share still running from before the tab was left comes back as it is.
  const [share, setShareState] = useState<Share | null>(() => lives.get(project)?.share ?? null);
  // A share left by opening another board while hosting: offered back in one click.
  const [offer, setOffer] = useState(() => (lives.has(project) ? null : remembered.get(project) ?? null));
  // The share as last set, for the function form below (Rejoin bumps the current one).
  const shareNow = useRef<Share | null>(null);
  shareNow.current = share;
  const setShare = (next: Share | null | ((x: Share | null) => Share | null)) => {
    const v = typeof next === "function" ? next(shareNow.current) : next;
    shareNow.current = v;
    setShareState(v);
    if (v) { remembered.set(project, { ...v, board: v.host ? active : "" }); setOffer(null); }
  };
  /** Ended on purpose: nothing to offer back. */
  const endShare = () => {
    const l = lives.get(project);
    // The host ending on purpose tells everyone; a guest just leaves.
    if (l) { void l.close(l.share.host); lives.delete(project); }
    remembered.delete(project); setOffer(null); setShare(null);
  };
  /** Back into the remembered share; a host goes back to the board it was sharing. */
  const resume = () => {
    if (!offer) return;
    if (offer.host && offer.board !== active) { lastBoard.set(project, offer.board); setActive(offer.board); }
    const { board: _b, ...again } = offer;
    setShare({ ...again, attempt: (again.attempt ?? 0) + 1 });
  };
  // Joining asks only for the code. No password: the host lets each person in (see p2p in Deck),
  // which is less to pass on and safer if the code leaks. No name either: Deck's own (Settings >
  // General, else the Google or Windows account's) is what the others see.
  const [codePrompt, setCodePrompt] = useState<NamePromptState | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Bumped to remount the board after its files were replaced on disk (a restore from a backup).
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setBoards(null);
    configRead(boardsKey(project)).then((t) => {
      if (!alive) return;
      const list: BoardRef[] = t.trim() ? JSON.parse(t) : DEFAULT_BOARDS;
      const want = lastBoard.get(project);
      setBoards(list.length ? list : DEFAULT_BOARDS);
      setActive(want !== undefined && list.some((b) => b.id === want) ? want : list[0]?.id ?? "");
    }).catch((e) => { console.warn("[canvas] boards load failed", e); if (alive) { setBoards(DEFAULT_BOARDS); setActive(""); } });
    return () => { alive = false; };
  }, [project]);

  const save = (next: BoardRef[]) => {
    setBoards(next);
    void configWrite(boardsKey(project), JSON.stringify(next)).catch((e) => console.warn("[canvas] boards save failed", e));
  };
  const open = (id: string) => {
    // Hosting is of one board: going to another ends it. Its backup stays on disk, so coming
    // back to the board offers to keep the shared changes or go back.
    if (share?.host && id !== active) {
      const l = lives.get(project);
      if (l) { void l.close(); lives.delete(project); }
      setShareState(null); setOffer(remembered.get(project) ?? null);
    }
    lastBoard.set(project, id); setActive(id);
  };

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
        void configWrite(key, "").catch((e) => console.warn("[canvas] board delete failed", e));
        void configWrite(filesKey(key), "").catch((e) => console.warn("[canvas] board delete failed", e));
        void configWrite(backupKey(key), "").catch((e) => console.warn("[canvas] board delete failed", e));
        const rest = boards.filter((x) => x.id !== id);
        // The last board is cleared rather than left as no board at all.
        save(rest.length ? rest : DEFAULT_BOARDS);
        if (id === active) open((rest[0] ?? DEFAULT_BOARDS[0]).id);
      },
    });
  };

  /** A board name not yet taken: "Plan copy", then "Plan copy 2". */
  const freeName = (base: string) => {
    let name = base;
    for (let n = 2; boards.some((b) => b.name === name); n++) name = `${base} ${n}`;
    return name;
  };

  /** A new board holding the given scene and pictures, placed right after `after`. */
  const addCopy = async (name: string, scene: string, files: string, after: string) => {
    const b = { id: newId(), name: freeName(name) };
    const key = sceneKey(project, b.id);
    await configWrite(key, scene).catch((e) => console.warn("[canvas] board copy save failed", e));
    if (files.trim()) await configWrite(filesKey(key), files).catch((e) => console.warn("[canvas] board copy save failed", e));
    setBoards((list) => {
      const next = [...(list ?? boards)];
      next.splice(next.findIndex((x) => x.id === after) + 1, 0, b);
      void configWrite(boardsKey(project), JSON.stringify(next)).catch((e) => console.warn("[canvas] boards save failed", e));
      return next;
    });
    return b;
  };

  // From what is saved, so a stroke drawn in the last moment (the save waits 800ms) can be missing.
  const duplicate = async (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    const key = sceneKey(project, id);
    const [scene, files] = await Promise.all([configRead(key).catch((e) => { console.warn("[canvas] board read failed", e); return ""; }), configRead(filesKey(key)).catch((e) => { console.warn("[canvas] board read failed", e); return ""; })]);
    open((await addCopy(`${b.name} copy`, scene, files, id)).id);
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
      {/* Right-click a board's tab for Rename, Duplicate and Delete. */}
      <div onContextMenu={(e) => {
        const id = (e.target as HTMLElement).closest(`[${TAB_ATTR}]`)?.getAttribute(TAB_ATTR);
        if (id == null) return;
        e.preventDefault();
        setTabMenu({ x: e.clientX, y: e.clientY, id });
      }}>
      <TabStrip chip
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
      </div>
      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)} items={[
          { label: "Rename", icon: Pencil, onClick: () => rename(tabMenu.id) },
          { label: "Duplicate", icon: Copy, onClick: () => void duplicate(tabMenu.id) },
          "sep",
          { label: "Delete", icon: Trash2, danger: true, onClick: () => remove(tabMenu.id) },
        ]} />
      )}
      {/* Keyed by board: Excalidraw reads initialData only when it mounts. A guest gets a board of
          its own, which starts empty and fills from the host. */}
      <Board key={share && !share.host ? `shared:${share.code}` : `${sceneKey(project, active)}#${reload}`}
        storeKey={sceneKey(project, active)} runInTerminal={runInTerminal}
        share={share}
        boardName={boards.find((b) => b.id === active)?.name ?? "Board"}
        onReload={() => setReload((n) => n + 1)}
        onSaveCopy={(name, scene, files) => addCopy(name, scene, files, active).then(() => {})}
        // No questions: the others may draw until the host says otherwise from the bar's menu.
        onHost={() => void userName().then((name) => setShare({ code: newCode(), host: true, name, mode: "edit" }))}
        onJoin={() => setCodePrompt({
          title: "Join a shared board", subtitle: "The code from whoever is sharing, like abcd-efgh-jkmn-pqrs",
          initial: "", confirmLabel: "Next",
          onSave: (text) => {
            const code = cleanCode(text);
            if (code) void userName().then((name) => setShare({ code, host: false, name }));
          },
        })}
        onStop={endShare}
        offer={!share && offer ? offer : null}
        project={project}
        onResume={resume}
        onDismissOffer={() => { remembered.delete(project); setOffer(null); setReload((n) => n + 1); }}
        onRejoin={() => setShare((x) => x && { ...x, attempt: (x.attempt ?? 0) + 1 })} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <NamePrompt state={codePrompt} onClose={() => setCodePrompt(null)} />
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
/**
 * Whether boards show a grid and snap to it: one choice for every board, kept in canvas-grid.
 * A grid is shown by default, without snapping.
 */
function useGrid(): [{ show: boolean; snap: boolean }, (next: { show: boolean; snap: boolean }) => void] {
  const [grid, setGrid] = useState({ show: true, snap: false });
  useEffect(() => {
    configRead("canvas-grid").then((t) => { if (t.trim()) setGrid((g) => ({ ...g, ...JSON.parse(t) })); }).catch((e) => console.warn("[canvas] grid settings load failed", e));
  }, []);
  return [grid, (next) => { setGrid(next); void configWrite("canvas-grid", JSON.stringify(next)).catch((e) => console.warn("[canvas] grid settings save failed", e)); }];
}

/** Whether Deck's background is light, following it as the theme changes (the deck-surface event
 *  applyTheme sends). The same test Deck's editor theme uses: relative luminance over 0.4. */
function useLightBackground(): boolean {
  const read = () => isLight(getComputedStyle(document.documentElement).getPropertyValue("--bg-app"));
  const [light, setLight] = useState(read);
  useEffect(() => {
    const on = (e: Event) => setLight(isLight((e as CustomEvent<{ app: string }>).detail?.app ?? ""));
    window.addEventListener("deck-surface", on);
    return () => window.removeEventListener("deck-surface", on);
  }, []);
  return light;
}
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (!m) return false;
  const lin = (c: string) => { const v = parseInt(c, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]) > 0.4;
}

function Board({ storeKey: key, runInTerminal: onRunInTerminal, share, boardName, onReload, onSaveCopy, onHost, onJoin, onStop, onRejoin, offer, onResume, onDismissOffer, project }: {
  storeKey: string;
  /** The project, which the live share is kept under. */
  project: string;
  runInTerminal: (label: string, command: string) => void;
  share: Share | null;
  boardName: string;
  /** Remount from what is on disk. */
  onReload: () => void;
  /** Add a board beside this one holding the given scene and pictures. */
  onSaveCopy: (name: string, scene: string, files: string) => Promise<void>;
  onHost: () => void;
  onJoin: () => void;
  onStop: () => void;
  /** Connect again to the same board (a guest whose connection dropped or never came up). */
  onRejoin: () => void;
  /** A share left by switching away, offered back in the bar. */
  offer: Share | null;
  onResume: () => void;
  onDismissOffer: () => void;
}) {
  const offerRef = useRef(offer);
  offerRef.current = offer;
  const shareRef = useRef(share);
  shareRef.current = share;
  // A guest's board is the host's: nothing of it is written to this machine.
  const guest = !!share && !share.host;
  const [initialData, setInitialData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scripts, setScripts] = useState<ScriptJob[]>([]);
  const apiRef = useRef<any>(null);
  const light = useLightBackground();
  const [grid, setGridState] = useGrid();
  // The grid's lines follow the scene as it pans and zooms. Written straight onto the box as CSS
  // variables on every change, rather than through React state: a pan is many changes a second.
  const gridBox = useRef<HTMLDivElement>(null);
  // The document the board is drawn in (see ownerDocument below), known once the box is mounted.
  const [doc, setDoc] = useState<Document | null>(null);
  const placeGrid = (st: any) => {
    const el = gridBox.current;
    if (!el || !st) return;
    const z = st.zoom?.value ?? 1, g = (st.gridSize || 20) * z, step = st.gridStep || 5;
    el.style.setProperty("--grid-x", `${(st.scrollX ?? 0) * z}px`);
    el.style.setProperty("--grid-y", `${(st.scrollY ?? 0) * z}px`);
    el.style.setProperty("--grid-minor-size", `${g}px`);
    el.style.setProperty("--grid-major-size", `${g * step}px`);
    // Too dense to read when zoomed far out: only the major lines, as Excalidraw does.
    el.style.setProperty("--grid-minor", g < 10 ? "transparent" : "color-mix(in srgb, var(--text-primary) 6%, transparent)");
  };
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
    if (pending.current !== null) void configWrite(key, pending.current).catch((e) => console.warn("[canvas] board save failed", e));
  }, [key]);

  // Script jobs resolve at CLICK time rather than being baked into the element: renaming or
  // editing a job in Script Runner then propagates, and a deleted one reads as missing instead
  // of running stale arguments.
  const scriptsRef = useRef<ScriptJob[]>([]);
  scriptsRef.current = scripts;
  useEffect(() => {
    configRead("data/script-runner/script-runner").then((t) => setScripts(t.trim() ? JSON.parse(t) : [])).catch((e) => console.warn("[canvas] script jobs load failed", e));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Still shared from before the tab was left: open from the share's copy, which has what
    // arrived meanwhile, rather than from disk.
    const l = lives.get(project);
    if (share && l?.matches(share) && (guest || l.boardKey === key)) {
      const c = l.current;
      savedFileIds.current = new Set(Object.keys(c.files));
      lastSaved.current = "";
      setInitialData({ elements: c.elements, appState: { ...(c.appState ?? {}), collaborators: undefined, theme: "dark" }, files: c.files });
      setLoading(false);
      return;
    }
    if (guest) {
      setInitialData({ elements: [], appState: { theme: "dark", viewBackgroundColor: "transparent" }, files: {} });
      setLoading(false);
      return;
    }
    Promise.all([configRead(key), configRead(filesKey(key)).catch((e) => { console.warn("[canvas] pictures load failed", e); return ""; })]).then(([t, f]) => {
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
        void configWrite(filesKey(key), JSON.stringify(files)).catch((e) => console.warn("[canvas] pictures save failed", e));
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
      // A share that ended without a choice (Deck closed, or another board opened while hosting).
      // Not while hosting it can be resumed: the backup is still that share's, and Dismiss on the
      // offer brings this choice back.
      if (!offerRef.current?.host && !shareRef.current?.host) configRead(backupKey(key)).then((b) => { if (alive && b.trim()) setEnding("leftover"); }).catch(() => {});
    }).catch((e) => {
      console.warn("[canvas] board load failed", e);
      if (!alive) return;
      setInitialData({ elements: [], appState: { theme: "dark", viewBackgroundColor: "transparent" }, files: {} });
      setLoading(false);
    });
    return () => { alive = false; };
  }, [key]);

  // ---- The backup taken when hosting starts, and what happens to it when hosting ends ----
  // "stop": the host pressed Stop. "leftover": the board opened with a backup from an earlier share.
  const [ending, setEnding] = useState<"stop" | "leftover" | null>(null);

  useEffect(() => {
    if (!share?.host) return;
    const a = apiRef.current;
    if (!a) return;
    // The oldest backup wins: sharing again before choosing keeps the board from before the first.
    const snapshot: Backup = {
      scene: serializeAsJSON(a.getSceneElements(), a.getAppState(), {}, "local"),
      files: JSON.stringify(a.getFiles() ?? {}),
      at: Date.now(),
    };
    configRead(backupKey(key)).catch(() => "").then((had) => {
      if (!had.trim()) void configWrite(backupKey(key), JSON.stringify(snapshot)).catch((e) => console.warn("[canvas] backup save failed", e));
    });
  }, [share?.code]);

  const dropBackup = () => configWrite(backupKey(key), "").catch((e) => console.warn("[canvas] backup delete failed", e));

  /** Put the board back as it was before sharing, from the backup on disk. */
  const restore = async () => {
    const raw = await configRead(backupKey(key)).catch((e) => { console.warn("[canvas] backup read failed", e); return ""; });
    if (!raw.trim()) return;
    const b: Backup = JSON.parse(raw);
    // Whatever is waiting to be saved belongs to the version being thrown away.
    clearTimeout(saveTimer.current);
    pending.current = null;
    await configWrite(key, b.scene).catch((e) => console.warn("[canvas] restore failed", e));
    await configWrite(filesKey(key), b.files).catch((e) => console.warn("[canvas] restore failed", e));
    await dropBackup();
    onReload();
  };

  /** The board as it is now, as a new board beside this one. */
  const saveCurrentAsCopy = async () => {
    const a = apiRef.current;
    if (!a) return;
    const when = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" });
    await onSaveCopy(`${boardName} (shared ${when})`,
      serializeAsJSON(a.getSceneElements(), a.getAppState(), {}, "local"), JSON.stringify(a.getFiles() ?? {}));
  };

  const finish = async (choice: "keep" | "restore" | "both") => {
    setEnding(null);
    if (share?.host) onStop();
    if (choice === "keep") await dropBackup();
    else {
      if (choice === "both") await saveCurrentAsCopy();
      await restore();
    }
  };

  // ---- Sharing: the live share (live.ts), kept while the board is off screen ----
  const [live, setLive] = useState<LiveShare | null>(null);
  const liveRef = useRef<LiveShare | null>(null);
  liveRef.current = live;
  useEffect(() => {
    if (!share) { setLive(null); return; }
    let l = lives.get(project);
    if (!l || !l.matches(share)) {
      if (l) void l.close();
      const a = apiRef.current;
      l = new LiveShare(share, key, boardName, a
        ? { elements: a.getSceneElementsIncludingDeleted(), appState: a.getAppState(), files: a.getFiles() ?? {} }
        : { elements: [], appState: {}, files: {} });
      lives.set(project, l);
    }
    setLive(l);
    if (apiRef.current) l.attach(apiRef.current);
    const mine = l;
    // Off screen, not over: the share goes on working on the board's last scene.
    return () => mine.detach(apiRef.current);
  }, [share?.code, share?.attempt]);
  const view = useSyncExternalStore(live?.subscribe ?? noSubscribe, live?.getView ?? noView);
  const { gone: hostGone, stuck, note } = view;
  const hostName = { current: view.hostName };

  /** A guest keeping what is on screen: the host's board, as a board of their own. */
  const keepGuestCopy = async () => {
    const a = apiRef.current;
    if (a) await onSaveCopy(`${view.hostName}'s board`,
      serializeAsJSON(a.getSceneElements(), a.getAppState(), {}, "local"), JSON.stringify(a.getFiles() ?? {}));
    onStop();
  };

  const onChange = (elements: readonly any[], appState: any, files: any) => {
    placeGrid(appState);
    // Excalidraw gates an embeddable's inner content behind an activation click: the first
    // press only selects the element, so a button needed two clicks to fire. Promoting it to
    // "active" as soon as it is hovered means the press lands on the button itself.
    if (appState?.activeEmbeddable?.state === "hover") {
      const el = appState.activeEmbeddable.element;
      apiRef.current?.updateScene({ appState: { activeEmbeddable: { element: el, state: "active" } } });
    }
    const l = liveRef.current;
    if (l && apiRef.current) {
      l.seenOnScreen(apiRef.current.getSceneElementsIncludingDeleted(), appState, files ?? {});
      l.queueSend();
    }
    if (guest) return;
    // A new picture: write the pictures file, once. Excalidraw's `files` holds every picture the
    // board has loaded, so this keeps one a deleted element still points at, for undo.
    const ids = Object.keys(files ?? {});
    if (ids.some((id) => !savedFileIds.current.has(id))) {
      savedFileIds.current = new Set(ids);
      void configWrite(filesKey(key), JSON.stringify(files)).catch((e) => console.warn("[canvas] pictures save failed", e));
    }
    // The scene without the pictures: a few kilobytes, so serialising it on every change is cheap.
    const json = serializeAsJSON(elements as any, appState, {}, "local");
    if (json === lastSaved.current) return; // view-only change (pan, zoom, selection)
    clearTimeout(saveTimer.current);
    setSaving(true);
    pending.current = json;
    saveTimer.current = setTimeout(async () => {
      pending.current = null;
      await configWrite(key, json).catch((e) => console.warn("[canvas] board save failed", e));
      lastSaved.current = json;
      setSaving(false);
    }, 800);
  };

  const runButton = (action: ButtonAction, arg: string, label: string) => {
    if (guest) return; // the host's paths and commands, not this machine's
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
      ref={(el) => { if (el && el.ownerDocument !== doc) setDoc(el.ownerDocument); }}
      onPointerMoveCapture={syncOffsets} onPointerEnter={syncOffsets}>
      {/* Behind the scene, which Excalidraw draws on a transparent background. */}
      <div ref={gridBox} aria-hidden className="deck-grid pointer-events-none absolute inset-0"
        style={{ display: grid.show && !grid.snap ? undefined : "none" }} />
      {doc && <Excalidraw
        // The document the board is drawn in: Deck's main window's, or a floating window's.
        // Excalidraw listens for pointer moves and keys on the one it is given, and takes the main
        // page's unless told, so in a floating window it heard nothing and drew nothing.
        ownerDocument={doc}
        initialData={initialData}
        // Excalidraw's own light or dark, to match Deck's background: its toolbar, zoom and
        // share buttons are drawn for one or the other, and the dark set was pale on a light page.
        theme={light ? "light" : "dark"}
        onChange={onChange}
        onExcalidrawAPI={(api: any) => { apiRef.current = api; liveRef.current?.attach(api); if (api) requestAnimationFrame(() => placeGrid(apiRef.current?.getAppState())); }}
        // Snapping is Excalidraw's grid mode, which also draws its own grid: so it is on only
        // while both the grid and snapping are, and our grid steps aside while it is.
        gridModeEnabled={grid.show && grid.snap}
        isCollaborating={!!share}
        viewModeEnabled={!!share && !view.canEdit}
        onPointerUpdate={((p: any) => liveRef.current?.pointer(p)) as any}
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
        // The grid and snapping to it, from two buttons at the top right. The same for every
        // board, so turning it on once is enough.
        renderTopRightUI={() => (
          <div className="flex gap-1">
            <button onClick={() => setGridState({ ...grid, show: !grid.show })}
              title={grid.show ? "Hide the grid" : "Show the grid"} aria-pressed={grid.show} className="deck-grid-toggle">
              <Grid3x3 size={16} />
            </button>
            <button onClick={() => setGridState({ ...grid, snap: !grid.snap })} disabled={!grid.show}
              title={!grid.show ? "Snap to the grid: show the grid first" : grid.snap ? "Stop snapping to the grid" : "Snap to the grid (hold Ctrl to move freely)"}
              aria-pressed={grid.show && grid.snap} className="deck-grid-toggle">
              <Magnet size={16} />
            </button>
          </div>
        )}
        UIOptions={{
          canvasActions: {
            // A board is per-project and autosaved; loading someone else's scene over it or
            // wiping it from a menu are not things that should be one click away.
            loadScene: false, saveAsImage: false, export: false, clearCanvas: false,
          },
        }}
      >
        <Footer>
          <ShareBar share={share} peers={view.peers} saving={saving && !guest}
            knocking={view.knocking} waiting={view.waiting} hostName={view.hostName}
            onAllow={(id) => liveRef.current?.allow(id)} onDeny={(id) => liveRef.current?.deny(id)}
            onKick={(id) => liveRef.current?.kick(id)} note={note} stuck={stuck} onRejoin={onRejoin}
            roles={view.roles} canEdit={view.canEdit}
            onDefault={(m) => liveRef.current?.setDefault(m)} onPerson={(id, m) => liveRef.current?.setPerson(id, m)}
            onHost={onHost} onJoin={onJoin} onStop={share?.host ? () => setEnding("stop") : onStop}
            offer={offer} onResume={onResume} onDismissOffer={onDismissOffer} />
        </Footer>
      </Excalidraw>}

      {/* The Link and Button entries that used to sit here were removed as unused. Buttons
          already on a board still work — runButton, decodeButton and AddButtonForm are all
          intact — there is simply no toolbar entry creating new ones. */}
      {hostGone && <HostGoneDialog why={hostGone} host={hostName.current}
        onKeep={() => void keepGuestCopy()} onClose={onStop} onRejoin={onRejoin} />}
      {ending && <ShareEndDialog leftover={ending === "leftover"} onChoose={(c) => void finish(c)}
        onCancel={() => setEnding(null)} />}
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

/** A choice in the end-of-sharing dialogs: a title and what it does, on the elevated surface. */
const CHOICE = "flex w-full flex-col items-start rounded-lg border border-subtle bg-elev px-3 py-2 text-left transition-colors hover:border-strong";
/** The dialogs' title and their line under it. */
const DIALOG_TITLE = "mb-1 text-[13px] font-medium text-text-primary";
const DIALOG_BODY = "mb-3 text-[12px] leading-relaxed text-text-muted";

/** A round trip above this is a slow connection: the dot in the bar turns amber. */
const SLOW_MS = 250;

/** Share, Join, or while shared: the code, who is here, and Stop. */
function ShareBar({ share, peers, saving, onHost, onJoin, onStop, onKick, note, stuck, onRejoin, offer, onResume, onDismissOffer, roles, canEdit, onDefault, onPerson, knocking, waiting, hostName, onAllow, onDeny }: {
  /** The host: who is asking to be let in. */
  knocking: Person[];
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
  /** A guest the host has not let in yet. */
  waiting: boolean;
  hostName: string;
  /** Who may draw, and whether this Deck may. */
  roles: Roles;
  canEdit: boolean;
  /** The host: everyone's default, and one person's own choice (`null` follows the default). */
  onDefault: (mode: Mode) => void;
  onPerson: (id: string, mode: Mode | null) => void;
  offer: Share | null;
  onResume: () => void;
  onDismissOffer: () => void;
  share: Share | null;
  /** A passing line: a picture too big to send, someone on another version. */
  note: string;
  /** A guest that has heard nothing from the host for a while. */
  stuck: boolean;
  /** Who is connected. */
  peers: Person[];
  /** Remove someone: offered to the host from the list of who is connected. */
  onKick: (id: string) => void;
  saving: boolean;
  onHost: () => void;
  onJoin: () => void;
  onStop: () => void;
  onRejoin: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [people, setPeople] = useState<{ x: number; y: number } | null>(null);
  const status = <>
    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: !peers.length || peers.some((p) => (p.ms ?? 0) > SLOW_MS) ? "rgb(var(--tone-amber-400))" : "rgb(var(--tone-green-400))" }} />
    {stuck && !peers.length ? "Can't reach the board: check the code, or your network"
      : waiting ? `Waiting for ${hostName} to let you in…`
      : <>{share?.host ? "Sharing" : "Joined"}{!canEdit ? " · view only" : ""} · {peers.length ? `with ${peers.map((p) => (p.ms === undefined ? p.name : `${p.name} · ${p.ms} ms`)).join(", ")}` : share?.host ? "waiting for someone" : "connecting…"}</>}
  </>;
  return (
    <div className="deck-share-row">
      {!share && offer ? (
        <div className="deck-share">
          <button onClick={onResume} title={offer.host ? "Share this board again, same code" : "Join that board again, same code"}>
            {offer.host ? <Share2 /> : <LogIn />} {offer.host ? "Resume sharing" : "Rejoin"} <span className="font-mono">{offer.code}</span>
          </button>
          <button onClick={onDismissOffer} title="Forget it">✕</button>
        </div>
      ) : !share ? (
        <div className="deck-share">
          <button onClick={onHost} title="Let someone else draw on this board with you"><Share2 /> Share</button>
          <button onClick={onJoin} title="Open a board someone shared with you"><LogIn /> Join</button>
        </div>
      ) : (
        <div className="deck-share">
          {/* The host clicks this for who may draw, and to remove someone. */}
          {share.host ? (
            <button title="Who may draw, who is here" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPeople({ x: r.left, y: r.top - 8 });
            }}>{status}</button>
          ) : <span className="deck-share-text">{status}</span>}
          {share.host && (
            <button className="font-mono" title="Copy the code"
              onClick={() => { void navigator.clipboard.writeText(share.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {}); }}>
              {share.code} {copied ? <Check /> : <Copy />}
            </button>
          )}
          {stuck && !share.host && <button onClick={onRejoin} title="Try connecting again">Rejoin</button>}
          <button onClick={onStop}>{share.host ? "Stop" : "Leave"}</button>
        </div>
      )}
      {/* Someone with the code asking to come in: the host lets them in, or not. */}
      {share?.host && knocking.map((p) => (
        <div key={p.id} className="deck-share deck-knock">
          <span className="deck-share-text"><UserPlus /> {p.name} wants to join</span>
          <button onClick={() => onAllow(p.id)} title={`Let ${p.name} onto the board`}>Let in</button>
          <button onClick={() => onDeny(p.id)} title={`Turn ${p.name} away`}>✕</button>
        </div>
      ))}
      {note && <span className="text-[11px] text-text-muted">{note}</span>}
      {saving && <span className="text-[11px] text-text-muted">Saving…</span>}
      {people && (
        <ContextMenu x={people.x} y={people.y} up onClose={() => setPeople(null)}
          items={[
            // Settings rows (checked): the menu stays open while they are flipped.
            // One tick for the default: on, everyone may draw; off, everyone only views.
            { label: "Others can edit", checked: roles.def === "edit", onClick: () => onDefault(roles.def === "edit" ? "view" : "edit") },
            ...peers.flatMap((p): MenuEntry[] => {
              const edits = (roles.per[p.id] ?? roles.def) === "edit";
              const flip: Mode = edits ? "view" : "edit";
              return ["sep",
                // Back to the default rather than a choice that only repeats it.
                { label: `${p.name} can edit`, checked: edits, onClick: () => onPerson(p.id, flip === roles.def ? null : flip) },
                { label: `Remove ${p.name}`, icon: UserX, danger: true, onClick: () => onKick(p.id) }];
            }),
          ]} />
      )}
    </div>
  );
}

/**
 * The choice at the end of hosting: keep what was drawn together, go back to the board as it was
 * before sharing, or both (the shared version becomes a board of its own).
 */
function ShareEndDialog({ leftover, onChoose, onCancel }: {
  leftover: boolean;
  onChoose: (choice: "keep" | "restore" | "both") => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[380px] rounded-xl border border-subtle p-4 shadow-2xl" style={{ background: "var(--bg-card)" }}>
        <div className={DIALOG_TITLE}>
          {leftover ? "This board was shared" : "Stop sharing"}
        </div>
        <p className={DIALOG_BODY}>
          {leftover
            ? "A copy of how it looked before sharing was kept. What do you want to keep?"
            : "A copy of how this board looked before sharing was kept. What do you want to keep?"}
        </p>
        <div className="flex flex-col gap-1.5">
          <button className={CHOICE} onClick={() => onChoose("keep")}>
            <span className="text-[12.5px] text-text-primary">Keep the changes</span>
            <span className="text-[11px] text-text-muted">The board stays as it is now; the copy is thrown away.</span>
          </button>
          <button className={CHOICE} onClick={() => onChoose("restore")}>
            <span className="text-[12.5px] text-text-primary">Go back to before sharing</span>
            <span className="text-[11px] text-text-muted">Everything drawn while shared is discarded.</span>
          </button>
          <button className={CHOICE} onClick={() => onChoose("both")}>
            <span className="text-[12.5px] text-text-primary">Keep both</span>
            <span className="text-[11px] text-text-muted">This board goes back; the shared version becomes a new board beside it.</span>
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <button className="rounded-lg px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-primary" onClick={onCancel}>
            {leftover ? "Decide later" : "Keep sharing"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** On a guest, once the host has stopped sharing or disappeared: keep a copy, or close. */
function HostGoneDialog({ why, host, onKeep, onClose, onRejoin }: {
  why: "ended" | "lost" | "removed" | "denied" | "version";
  host: string;
  onKeep: () => void;
  onClose: () => void;
  /** Offered when the connection dropped: the host may still be sharing. */
  onRejoin: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div className="w-[380px] rounded-xl border border-subtle p-4 shadow-2xl" style={{ background: "var(--bg-card)" }}>
        <div className={DIALOG_TITLE}>
          {why === "ended" ? `${host} stopped sharing` : why === "removed" ? `${host} removed you from the board`
            : why === "denied" ? `${host} didn't let you in`
            : why === "version" ? `${host} has a different Canvas version` : `Lost the connection to ${host}`}
        </div>
        <p className={DIALOG_BODY}>
          {why === "version"
            ? "Both of you need the same Canvas build to share a board. Update Canvas, then join again."
            : why === "denied" ? "Ask them to share again if that was a mistake."
            : `The board stays with ${host}. You can keep what you see as a board of your own.`}
        </p>
        <div className="flex flex-col gap-1.5">
          {why === "lost" && (
            <button className={CHOICE} onClick={onRejoin}>
              <span className="text-[12.5px] text-text-primary">Rejoin</span>
              <span className="text-[11px] text-text-muted">Connect to {host}'s board again, if they are still sharing.</span>
            </button>
          )}
          {why !== "denied" && <button className={CHOICE} onClick={onKeep}>
            <span className="text-[12.5px] text-text-primary">Keep a copy</span>
            <span className="text-[11px] text-text-muted">Saved as a new board here, "{host}'s board".</span>
          </button>}
          <button className={CHOICE} onClick={onClose}>
            <span className="text-[12.5px] text-text-primary">Close</span>
            <span className="text-[11px] text-text-muted">Back to your own boards.</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Not sharing: nothing to subscribe to, and one unchanging view. A new object on each read would
// look like a change to useSyncExternalStore every time, and render without end.
const noSubscribe = () => () => {};
const NO_VIEW: LiveView = { peers: [], knocking: [], waiting: false, stuck: false, gone: null, hostName: "the host", note: "", roles: { def: "edit", per: {} }, canEdit: true };
const noView = () => NO_VIEW;
