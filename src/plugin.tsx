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
import { TerminalSquare, FileCog, ExternalLink, Loader2, Share2, Copy, Pencil, Trash2, Grid3x3, Magnet, Users } from "lucide-react";
import { subscribeTeams, teamsView } from "../shim/p2p.js";
import { attachBoard, boardChanged, boardPointer, boardViewers, deleteTeamBoard, renameTeamBoard, shareAlways, startTeamBoards, stopTeamBoards, subscribeTeamBoards, teamBoardKey, teamBoards, teamBoardsVersion } from "./teamboards";

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
/* The share control, in the footer row beside zoom and undo, drawn the way those are: a
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
/* The same gap Excalidraw leaves between its zoom and undo islands. */
.deck-canvas .deck-share-row { display: flex; gap: .6em; align-items: center; margin-inline-start: .6em; }
`;
const style = document.createElement("style");
style.dataset.plugin = "canvas";
style.textContent = excalidrawCss + DECK_THEME;
document.head.appendChild(style);
// Boards shared with a team keep in step with the Canvas tab closed too (teamboards.ts).
void startTeamBoards().catch((e) => console.warn("[canvas] starting the team boards failed", e));

export function dispose() {
  stopTeamBoards();
  style.remove();
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
/** A board always shared with a team is a tab id `team:<id>` (teamboards.ts), beside the project's own. */
const teamOf = (tab: string) => (tab.startsWith("team:") ? tab.slice(5) : null);

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

/** What a live share (since removed) kept of a board, `<key>-share-backup`: cleared with the board. */
const backupKey = (key: string) => `${key}-share-backup`;

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
  const teams = useSyncExternalStore(subscribeTeams, teamsView);
  useSyncExternalStore(subscribeTeamBoards, teamBoardsVersion);
  const shared = teamBoards();
  const tActive = teamOf(active);
  const activeKey = tActive ? teamBoardKey(tActive) : sceneKey(project, active);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setBoards(null);
    configRead(boardsKey(project)).then((t) => {
      if (!alive) return;
      const list: BoardRef[] = t.trim() ? JSON.parse(t) : DEFAULT_BOARDS;
      const want = lastBoard.get(project);
      setBoards(list.length ? list : DEFAULT_BOARDS);
      setActive(want !== undefined && (list.some((b) => b.id === want) || teamOf(want)) ? want : list[0]?.id ?? "");
    }).catch((e) => { console.warn("[canvas] boards load failed", e); if (alive) { setBoards(DEFAULT_BOARDS); setActive(""); } });
    return () => { alive = false; };
  }, [project]);

  const save = (next: BoardRef[]) => {
    setBoards(next);
    void configWrite(boardsKey(project), JSON.stringify(next)).catch((e) => console.warn("[canvas] boards save failed", e));
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
    const t = teamOf(id), tb = t && shared.find((x) => x.id === t);
    if (tb) {
      setConfirm({ title: `Delete "${tb.name}" for the team?`, body: "It goes from every member's Deck, as they come online.", confirmLabel: "Delete",
        onConfirm: () => { void deleteTeamBoard(tb.id); if (id === active) open(boards[0]?.id ?? ""); } });
      return;
    }
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
    const t = teamOf(id);
    const b = t ? shared.find((x) => x.id === t) : boards.find((x) => x.id === id);
    if (!b) return;
    const key = t ? teamBoardKey(t) : sceneKey(project, id);
    const [scene, files] = await Promise.all([configRead(key).catch((e) => { console.warn("[canvas] board read failed", e); return ""; }), configRead(filesKey(key)).catch((e) => { console.warn("[canvas] board read failed", e); return ""; })]);
    open((await addCopy(`${b.name} copy`, scene, files, id)).id);
  };

  const rename = (id: string) => {
    const t = teamOf(id), tb = t && shared.find((x) => x.id === t);
    if (tb) {
      setRenaming({ title: "Rename shared board", initial: tb.name, confirmLabel: "Rename", onSave: (to) => { if (to.trim()) void renameTeamBoard(tb.id, to.trim()); } });
      return;
    }
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    setRenaming({
      title: "Rename board", initial: b.name, confirmLabel: "Rename",
      onSave: (to) => { if (to.trim()) save(boards.map((x) => (x.id === id ? { ...x, name: to.trim() } : x))); },
    });
  };

  /** A project board, moved to be always shared with a team: it leaves this project's tabs. */
  const shareWith = async (id: string, team: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    const key = sceneKey(project, id);
    const [scene, files] = await Promise.all([configRead(key).catch(() => ""), configRead(filesKey(key)).catch(() => "")]);
    const tb = await shareAlways(b.name, team, scene, files).catch((e) => { console.warn("[canvas] sharing a board with the team failed", e); return null; });
    if (!tb) return;
    // The drawing now lives under the shared board's keys: the project's copy goes, or a project's
    // only board (id "", which comes back as the empty first board) would still hold it.
    for (const k of [key, filesKey(key), backupKey(key)]) void configWrite(k, "").catch((e) => console.warn("[canvas] clearing a board moved to the team failed", e));
    const rest = boards.filter((x) => x.id !== id);
    save(rest.length ? rest : DEFAULT_BOARDS);
    open(`team:${tb.id}`);
  };
  /** A shared board back into this project: a copy here, and the board goes from the team. */
  const stopSharing = (id: string) => {
    const t = teamOf(id), tb = t && shared.find((x) => x.id === t);
    if (!tb) return;
    setConfirm({ title: `Stop sharing "${tb.name}"?`, confirmLabel: "Stop sharing", danger: false,
      body: "A copy stays in this project's boards; the board goes from the others' Decks.",
      onConfirm: () => void (async () => {
        const [scene, files] = await Promise.all([configRead(teamBoardKey(tb.id)).catch(() => ""), configRead(filesKey(teamBoardKey(tb.id))).catch(() => "")]);
        const copy = await addCopy(tb.name, scene, files, boards[boards.length - 1]?.id ?? "");
        await deleteTeamBoard(tb.id);
        open(copy.id);
      })() });
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
        tabs={[...boards.map((b) => ({ id: b.id, title: b.name, closeTitle: "Delete board" })),
          ...shared.map((b) => ({ id: `team:${b.id}`, title: b.name, icon: <Users size={12} />, closeTitle: "Delete for the team" }))]}
        activeId={active}
        onSelect={open}
        onClose={remove}
        onDoubleClick={rename}
        onReorder={(from, to) => {
          if (teamOf(from) || teamOf(to)) return;
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
          ...(teamOf(tabMenu.id)
            ? [{ label: "Stop sharing with the team", icon: Users, onClick: () => stopSharing(tabMenu.id) }]
            : teams.map((t) => ({ label: `Always share with ${t.name}`, icon: Users, onClick: () => void shareWith(tabMenu.id, t.id) }))),
          "sep",
          { label: "Delete", icon: Trash2, danger: true, onClick: () => remove(tabMenu.id) },
        ]} />
      )}
      {/* Keyed by board: Excalidraw reads initialData only when it mounts. */}
      <Board key={activeKey}
        storeKey={activeKey} teamBoard={tActive ?? undefined} runInTerminal={runInTerminal}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        team={tActive ? teams.find((t) => t.id === shared.find((b) => b.id === tActive)?.team)?.name ?? "the team" : ""}
        here={tActive ? boardViewers(tActive) : []}
        onShare={(team) => void shareWith(active, team)} />
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

function Board({ storeKey: key, teamBoard, runInTerminal: onRunInTerminal, teams, team, here, onShare }: {
  storeKey: string;
  /** Set for a board always shared with a team (teamboards.ts): its id there. */
  teamBoard?: string;
  runInTerminal: (label: string, command: string) => void;
  /** The Deck teams this one is in, for Share. */
  teams: { id: string; name: string }[];
  /** A shared board's team, by name, and who else has it open now. */
  team: string;
  here: string[];
  /** Share this board with a team, for good (it moves out of the project). */
  onShare: (team: string) => void;
}) {
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
  // A board always shared with a team is attached to it while on screen (teamboards.ts).
  const detachTeam = useRef<(() => void) | null>(null);
  useEffect(() => () => { detachTeam.current?.(); detachTeam.current = null; }, [key]);
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
    }).catch((e) => {
      console.warn("[canvas] board load failed", e);
      if (!alive) return;
      setInitialData({ elements: [], appState: { theme: "dark", viewBackgroundColor: "transparent" }, files: {} });
      setLoading(false);
    });
    return () => { alive = false; };
  }, [key]);

  const onChange = (elements: readonly any[], appState: any, files: any) => {
    placeGrid(appState);
    // Excalidraw gates an embeddable's inner content behind an activation click: the first
    // press only selects the element, so a button needed two clicks to fire. Promoting it to
    // "active" as soon as it is hovered means the press lands on the button itself.
    if (appState?.activeEmbeddable?.state === "hover") {
      const el = appState.activeEmbeddable.element;
      apiRef.current?.updateScene({ appState: { activeEmbeddable: { element: el, state: "active" } } });
    }
    if (teamBoard) boardChanged(teamBoard);
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
        onExcalidrawAPI={(api: any) => { apiRef.current = api; detachTeam.current?.(); detachTeam.current = api && teamBoard ? attachBoard(teamBoard, api) : null; if (api) requestAnimationFrame(() => placeGrid(apiRef.current?.getAppState())); }}
        // Snapping is Excalidraw's grid mode, which also draws its own grid: so it is on only
        // while both the grid and snapping are, and our grid steps aside while it is.
        gridModeEnabled={grid.show && grid.snap}
        isCollaborating={!!teamBoard}
        onPointerUpdate={((p: any) => { if (teamBoard) boardPointer(teamBoard, p); }) as any}
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
          <TeamBar teams={teams} team={team} here={here} saving={saving} onShare={onShare} />
        </Footer>
      </Excalidraw>}

      {/* The Link and Button entries that used to sit here were removed as unused. Buttons
          already on a board still work — runButton, decodeButton and AddButtonForm are all
          intact — there is simply no toolbar entry creating new ones. */}
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

/**
 * The footer's share control. A project board: Share, with the teams to share it with for good. A
 * board shared with a team: whose it is and who else has it open, so it is plain it is live.
 */
function TeamBar({ teams, team, here, saving, onShare }: {
  teams: { id: string; name: string }[]; team: string; here: string[]; saving: boolean; onShare: (team: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="deck-share-row">
      <div className="deck-share">
        {team ? (
          <span className="deck-share-text" title="Kept in step with every member of the team">
            <Users /> Shared with {team}{here.length ? ` · ${here.join(", ")} here` : ""}
          </span>
        ) : (
          <button onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
            title={teams.length ? "Share this board with a Deck team, for good" : "Start or join a team in Settings > Teams first"}>
            <Share2 /> Share
          </button>
        )}
      </div>
      {saving && <span className="text-[11px] text-text-muted">Saving…</span>}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={teams.length
          ? teams.map((t): MenuEntry => ({ label: `Always share with ${t.name}`, icon: Users, onClick: () => onShare(t.id) }))
          : [{ label: "Start or join a team in Settings > Teams first", disabled: true, onClick: () => {} }]} />
      )}
    </div>
  );
}
