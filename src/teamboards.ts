// Boards always shared with a Deck team: no invite, no host. Each member's Deck keeps its own copy
// of the board, and whenever two members are online together their copies are brought together,
// element by element, by Excalidraw's own versions (reconcileElements, as a live share does). A
// board drawn on while alone reaches the others the next time they meet; one open on two Decks at
// once follows along as it is drawn. Share › invite (live.ts, teaminvite.ts) stays beside this for
// a one-off session.
//
// Shared boards are not a project's: they show in every project's tabs (plugin.tsx), stored under
// their own keys, `teamboard_<id>` and its `-files`. Which boards a team has is a list kept in
// `team-boards`, each entry with a revision so a rename or a delete wins over an older copy and a
// deleted board does not come back from a Deck that has not heard yet.
//
// From another Deck, only what sync.ts's fromPeer lets through: no buttons, no embedded pages, a
// link only to the web or mail. This Deck's own buttons are never sent (forPeers).
import { CaptureUpdateAction, reconcileElements } from "@excalidraw/excalidraw";
import { configRead, configWrite } from "../shim/bridge.js";
import { myTeamId, subscribeTeams, teamChannel, teamsView, type Member, type TeamChannel } from "../shim/p2p.js";
import { forPeers, fromPeer, markSeen, takeChanged, takeNewFiles, type Seen } from "./sync";

export interface Rev { t: number; by: string }
export interface TeamBoard { id: string; name: string; team: string; rev: Rev; del?: boolean }

type Msg =
  | { t: "list"; boards: TeamBoard[] }
  | { t: "els"; id: string; elements: unknown[] }
  | { t: "need"; id: string; ids: string[] }
  | { t: "files"; id: string; files: unknown[] };

const LIST = "team-boards";
export const teamBoardKey = (id: string) => `teamboard_${id}`;
const filesKey = (key: string) => `${key}-files`;
/** A picture bigger than this is not sent, as in a live share. */
const MAX_PICTURE = 4 * 1024 * 1024;
/** How far ahead of this clock a revision may be: a later one would win over every edit for good. */
const FUTURE = 10 * 60_000;

// ---- pure: the list, and what may arrive ----

export const validId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const newer = (a: Rev, b?: Rev) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);

/** A list entry from another Deck as this one takes it, or null. */
export function cleanBoard(v: unknown, now: number): TeamBoard | null {
  const b = v as TeamBoard | null;
  if (!b || !validId(b.id) || typeof b.name !== "string" || b.name.length > 200 || typeof b.team !== "string" || b.team.length > 64
    || !b.rev || typeof b.rev.t !== "number" || !Number.isFinite(b.rev.t) || b.rev.t > now + FUTURE
    || typeof b.rev.by !== "string" || b.rev.by.length > 64 || (b.del !== undefined && typeof b.del !== "boolean")) return null;
  return { id: b.id, name: b.name, team: b.team, rev: { t: b.rev.t, by: b.rev.by }, ...(b.del ? { del: true } : {}) };
}

/** `mine` with what `theirs` has newer, for team `team` only. */
export function mergeList(mine: TeamBoard[], theirs: unknown, team: string, now: number): { list: TeamBoard[]; changed: string[] } {
  if (!Array.isArray(theirs)) return { list: mine, changed: [] };
  const byId = new Map(mine.map((b) => [b.id, b]));
  const changed: string[] = [];
  for (const raw of theirs.slice(0, 500)) {
    const b = cleanBoard(raw, now);
    if (!b || b.team !== team) continue;
    const have = byId.get(b.id);
    // A board this Deck has for another team stays that team's.
    if (have && have.team !== team) continue;
    if (!newer(b.rev, have?.rev)) continue;
    byId.set(b.id, b);
    changed.push(b.id);
  }
  return { list: changed.length ? [...byId.values()] : mine, changed };
}

/** Elements from another Deck: a list of objects with an id and a version, then fromPeer's filter. */
export function cleanElements(v: unknown): any[] | null {
  if (!Array.isArray(v) || v.length > 20_000) return null;
  return v.filter((e) => e && typeof e === "object" && typeof e.id === "string" && e.id.length <= 64
    && typeof e.version === "number" && Number.isFinite(e.version)).flatMap((e) => fromPeer(e) ?? []);
}

/** Pictures from another Deck: Excalidraw's shape, an image data: URL, within the size. */
export function cleanFiles(v: unknown): any[] {
  if (!Array.isArray(v)) return [];
  return v.filter((f) => f && typeof f.id === "string" && f.id.length <= 128 && typeof f.mimeType === "string" && /^image\//.test(f.mimeType)
    && typeof f.dataURL === "string" && f.dataURL.startsWith("data:image/") && f.dataURL.length <= MAX_PICTURE * 1.4)
    .map((f) => ({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: typeof f.created === "number" ? f.created : Date.now() }));
}

// ---- the store ----

let list: TeamBoard[] = [];
let listText = "";
let me = "";
let stopped = true;
let version = 0;
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };
export const subscribeTeamBoards = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const teamBoardsVersion = () => version;
/** The shared boards of the teams this Deck is in, not deleted. */
export const teamBoards = () => { const teams = new Set(teamsView().map((t) => t.id)); return list.filter((b) => !b.del && teams.has(b.team)); };

const chans = new Map<string, TeamChannel<any>>();
/** Per board: the element versions sent or received, so nothing is sent back where it came from. */
const seen = new Map<string, Seen>();
const seenOf = (id: string) => seen.get(id) ?? seen.set(id, new Map()).get(id)!;
/** Per board: the pictures already sent. */
const filesSent = new Map<string, Set<string>>();
/** The boards open on screen, by id: arrivals go into them, and their changes go out. */
const open = new Map<string, any>();

async function saveList() {
  const t = JSON.stringify(list);
  if (t === listText) return;
  listText = t;
  await configWrite(LIST, t).catch((e) => console.warn("[canvas] saving the team boards failed", e));
}

const readJson = async (key: string) => { const t = await configRead(key).catch(() => ""); try { return t.trim() ? JSON.parse(t) : null; } catch { return null; } };

/** A board's elements as this Deck has them, deleted ones included (so a delete travels). */
async function elementsOf(id: string): Promise<any[]> {
  const api = open.get(id);
  if (api) return api.getSceneElementsIncludingDeleted();
  return (await readJson(teamBoardKey(id)))?.elements ?? [];
}
async function filesOf(id: string): Promise<Record<string, any>> {
  const api = open.get(id);
  if (api) return api.getFiles() ?? {};
  return (await readJson(filesKey(teamBoardKey(id)))) ?? {};
}

function channels() {
  if (stopped) return;
  const want = new Set(teamsView().map((t) => t.id));
  for (const [team, ch] of chans) if (!want.has(team)) { ch.close(); chans.delete(team); }
  for (const team of want) {
    if (chans.has(team)) continue;
    chans.set(team, teamChannel<any>(team, "boards", {
      joined: (m) => void hello(team, m),
      message: (msg: Msg, from) => void onMsg(team, msg, from),
    }));
  }
  emit();
}

/** Someone came online: what this Deck has of their team's boards. */
async function hello(team: string, m: Member) {
  const ch = chans.get(team);
  if (!ch) return;
  const mine = list.filter((b) => b.team === team);
  if (!mine.length) return;
  await ch.send({ t: "list", boards: mine }, m.id);
  for (const b of mine) if (!b.del) await ch.send({ t: "els", id: b.id, elements: forPeers(await elementsOf(b.id)) }, m.id);
}

async function onMsg(team: string, msg: Msg, from: Member) {
  if (stopped || !msg || typeof msg !== "object") return;
  const ch = chans.get(team);
  if (msg.t === "list") {
    const r = mergeList(list, msg.boards, team, Date.now());
    if (!r.changed.length) return;
    list = r.list;
    await saveList();
    // A board deleted for the team goes from this Deck too.
    for (const id of r.changed) if (list.find((b) => b.id === id)?.del) {
      for (const k of [teamBoardKey(id), filesKey(teamBoardKey(id))]) void configWrite(k, "").catch(() => {});
      seen.delete(id); filesSent.delete(id);
    }
    emit();
    return;
  }
  if (!validId((msg as { id?: unknown }).id)) return;
  const board = list.find((b) => b.id === (msg as { id: string }).id && b.team === team && !b.del);
  if (!board) return;
  if (msg.t === "els") {
    const remote = cleanElements(msg.elements);
    if (!remote?.length) return;
    await take(board.id, remote);
    // The pictures this board shows and this Deck does not have: asked of whoever sent it.
    const have = await filesOf(board.id);
    const want = [...new Set(remote.filter((e) => e.type === "image" && typeof e.fileId === "string" && !e.isDeleted).map((e) => e.fileId as string))].filter((f) => !have[f]);
    if (want.length) void ch?.send({ t: "need", id: board.id, ids: want.slice(0, 200) }, from.id);
  } else if (msg.t === "need" && Array.isArray(msg.ids)) {
    const files = await filesOf(board.id);
    for (const fid of msg.ids.slice(0, 200)) {
      const f = typeof fid === "string" ? files[fid] : null;
      if (f && f.dataURL?.length <= MAX_PICTURE * 1.4) await ch?.send({ t: "files", id: board.id, files: [f] }, from.id);
    }
  } else if (msg.t === "files") {
    const got = cleanFiles(msg.files);
    if (!got.length) return;
    for (const f of got) (filesSent.get(board.id) ?? filesSent.set(board.id, new Set()).get(board.id)!).add(f.id);
    const api = open.get(board.id);
    if (api) { api.addFiles(got); return; } // the board's own save writes them
    const files = await filesOf(board.id);
    for (const f of got) files[f.id] = f;
    await configWrite(filesKey(teamBoardKey(board.id)), JSON.stringify(files)).catch((e) => console.warn("[canvas] saving a team board's pictures failed", e));
  }
}

/** Another Deck's elements, into this Deck's copy: on screen when the board is open, else on disk. */
async function take(id: string, remote: any[]) {
  markSeen(remote, seenOf(id));
  const api = open.get(id);
  if (api) {
    api.updateScene({ elements: reconcileElements(api.getSceneElementsIncludingDeleted(), remote, api.getAppState()), captureUpdate: CaptureUpdateAction.NEVER });
    return; // its onChange saves it
  }
  const key = teamBoardKey(id);
  const scene = (await readJson(key)) ?? { type: "excalidraw", version: 2, source: "deck", elements: [], appState: {} };
  scene.elements = reconcileElements(scene.elements ?? [], remote, {} as any);
  await configWrite(key, JSON.stringify(scene)).catch((e) => console.warn("[canvas] saving a team board failed", e));
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** A shared board changed on screen here: what changed goes to the team's members online. */
export function boardChanged(id: string) {
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const api = open.get(id), board = list.find((b) => b.id === id && !b.del);
    const ch = board && chans.get(board.team);
    if (!api || !ch || !ch.online().length) return;
    const out = forPeers(takeChanged<any>(api.getSceneElementsIncludingDeleted(), seenOf(id)));
    if (out.length) void ch.send({ t: "els", id, elements: out });
    const sent = filesSent.get(id) ?? filesSent.set(id, new Set()).get(id)!;
    const { send } = takeNewFiles(api.getFiles() ?? {}, api.getSceneElements(), sent, MAX_PICTURE);
    for (const f of send) void ch.send({ t: "files", id, files: [f] });
  }, 150));
}

/** A shared board on screen: arrivals go into it. The returned function takes it off. */
export function attachBoard(id: string, api: any): () => void {
  open.set(id, api);
  // What it opened with is what this Deck has: only later changes are news.
  markSeen(api.getSceneElementsIncludingDeleted(), seenOf(id));
  return () => { if (open.get(id) === api) open.delete(id); };
}

async function myId() {
  me ||= await myTeamId();
  return me;
}

async function put(b: TeamBoard) {
  list = [...list.filter((x) => x.id !== b.id), b];
  await saveList();
  emit();
  void chans.get(b.team)?.send({ t: "list", boards: [b] });
}

/** Share a board with a team for good: a new shared board holding this scene and its pictures. */
export async function shareAlways(name: string, team: string, scene: string, files: string): Promise<TeamBoard> {
  const id = Math.random().toString(36).slice(2, 10);
  await configWrite(teamBoardKey(id), scene || JSON.stringify({ type: "excalidraw", version: 2, source: "deck", elements: [], appState: {} }));
  if (files.trim()) await configWrite(filesKey(teamBoardKey(id)), files);
  const b: TeamBoard = { id, name: name.slice(0, 200), team, rev: { t: Date.now(), by: await myId() } };
  await put(b);
  const ch = chans.get(team);
  if (ch?.online().length) await ch.send({ t: "els", id, elements: forPeers((await readJson(teamBoardKey(id)))?.elements ?? []) });
  return b;
}

export async function renameTeamBoard(id: string, name: string) {
  const b = list.find((x) => x.id === id);
  if (b) await put({ ...b, name: name.slice(0, 200), rev: { t: Math.max(Date.now(), b.rev.t + 1), by: await myId() } });
}

/** Delete a shared board for everyone in its team. */
export async function deleteTeamBoard(id: string) {
  const b = list.find((x) => x.id === id);
  if (!b) return;
  await put({ ...b, del: true, rev: { t: Math.max(Date.now(), b.rev.t + 1), by: await myId() } });
  for (const k of [teamBoardKey(id), filesKey(teamBoardKey(id))]) void configWrite(k, "").catch(() => {});
}

/** Whose team a shared board is, by name, for its tab. */
export const teamName = (team: string) => teamsView().find((t) => t.id === team)?.name ?? "the team";

let unTeams: (() => void) | null = null;
export async function startTeamBoards() {
  stopped = false;
  const t = await configRead(LIST).catch(() => "");
  if (stopped) return;
  listText = t;
  try { list = t.trim() ? JSON.parse(t) : []; } catch { list = []; }
  unTeams = subscribeTeams(channels);
  channels();
}
export function stopTeamBoards() {
  stopped = true;
  unTeams?.(); unTeams = null;
  for (const ch of chans.values()) ch.close();
  chans.clear();
  timers.forEach(clearTimeout); timers.clear();
}
