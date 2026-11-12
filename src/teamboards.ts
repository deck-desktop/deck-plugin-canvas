// Boards shared with a Deck team, the one way Canvas shares: no invite, no host. Each member's
// Deck keeps its own copy of the board, and whenever two members are online together their copies
// are brought together, element by element, by Excalidraw's own versions (reconcileElements). A
// board drawn on while alone reaches the others the next time they meet; one open on two Decks at
// once follows along as it is drawn, with the others' cursors.
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
/** `owner`: the member who shared it. Only they and the team's owner may delete it, or stop
 *  sharing it; everyone may draw on it and rename it. */
export interface TeamBoard { id: string; name: string; team: string; rev: Rev; del?: boolean; owner?: string }

type Msg =
  | { t: "list"; boards: TeamBoard[] }
  | { t: "els"; id: string; elements: unknown[] }
  | { t: "need"; id: string; ids: string[] }
  | { t: "files"; id: string; files: unknown[] }
  /** This Deck has the board on screen, or no longer: pointers go only to those who do. */
  | { t: "view"; id: string; on: boolean }
  | { t: "ptr"; id: string; x: number; y: number; button: "up" | "down"; tool: "pointer" | "laser" }
  /** A round trip, timed by whoever sent the ping: shown beside each name in the footer. */
  | { t: "ping"; id: string; n: number }
  | { t: "pong"; id: string; n: number }
  /** Now and then: a sum of each board's elements, so a board that drifted apart (a lost message)
   *  is sent whole and merged. Older Canvases ignore it. */
  | { t: "sum"; sums: [string, string][] };

const LIST = "team-boards";
export const teamBoardKey = (id: string) => `teamboard_${id}`;
const filesKey = (key: string) => `${key}-files`;
/** A picture bigger than this is not sent, as in a live share. */
const MAX_PICTURE = 4 * 1024 * 1024;
/** How far ahead of this clock a revision may be: a later one would win over every edit for good. */
const FUTURE = 10 * 60_000;
/** How often each Deck sends its board list and sums to those online. */
const CATCH_UP = 2 * 60_000;

/** A short sum of a board's elements (id, version and nonce of each, deleted ones too): two Decks
 *  with the same elements get the same sum. */
export function sumOf(elements: { id?: unknown; version?: unknown; versionNonce?: unknown }[]): string {
  const parts = elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}`).sort();
  let h = 0x811c9dc5;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return `${parts.length}-${(h >>> 0).toString(36)}`;
}

// ---- pure: the list, and what may arrive ----

export const validId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const newer = (a: Rev, b?: Rev) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);

/** A list entry from another Deck as this one takes it, or null. */
export function cleanBoard(v: unknown, now: number): TeamBoard | null {
  const b = v as TeamBoard | null;
  if (!b || !validId(b.id) || typeof b.name !== "string" || b.name.length > 200 || typeof b.team !== "string" || b.team.length > 64
    || !b.rev || typeof b.rev.t !== "number" || !Number.isFinite(b.rev.t) || b.rev.t > now + FUTURE
    || typeof b.rev.by !== "string" || b.rev.by.length > 64 || (b.del !== undefined && typeof b.del !== "boolean")
    || (b.owner !== undefined && (typeof b.owner !== "string" || b.owner.length > 64))) return null;
  return { id: b.id, name: b.name, team: b.team, rev: { t: b.rev.t, by: b.rev.by }, ...(b.del ? { del: true } : {}), ...(b.owner ? { owner: b.owner } : {}) };
}

/** Whether member `who` may delete board `b`, or stop sharing it: who shared it, or the team's owner. */
export const mayManage = (b: Pick<TeamBoard, "owner">, who: string, teamOwner: string | undefined) =>
  !!who && (who === b.owner || who === teamOwner);

/**
 * `mine` with what `theirs` has newer, for team `team` only. A board keeps the owner it was shared
 * with; a delete counts only from that owner or the team's owner (`teamOwner`), and a deleted board
 * stays deleted.
 */
export function mergeList(mine: TeamBoard[], theirs: unknown, team: string, now: number, teamOwner?: string): { list: TeamBoard[]; changed: string[] } {
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
    if (have?.del) continue;
    if (have) {
      if (b.del && !mayManage(have, b.rev.by, teamOwner)) continue;
      b.owner = have.owner;
    }
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
      left: (m) => gone(m.id),
      message: (msg: Msg, from) => void onMsg(team, msg, from),
    }));
  }
  emit();
}

/** Someone came online: what this Deck has of their team's boards. */
async function hello(team: string, m: Member) {
  const ch = chans.get(team);
  if (!ch) return;
  for (const id of open.keys()) if (list.some((b) => b.id === id && b.team === team && !b.del)) void ch.send({ t: "view", id, on: true }, m.id);
  const mine = list.filter((b) => b.team === team);
  if (!mine.length) return;
  await ch.send({ t: "list", boards: mine }, m.id);
  for (const b of mine) if (!b.del) await ch.send({ t: "els", id: b.id, elements: forPeers(await elementsOf(b.id)) }, m.id);
}

async function onMsg(team: string, msg: Msg, from: Member) {
  if (stopped || !msg || typeof msg !== "object") return;
  const ch = chans.get(team);
  if (msg.t === "sum") {
    if (!Array.isArray(msg.sums)) return;
    for (const pair of msg.sums.slice(0, 500)) {
      if (!Array.isArray(pair) || !validId(pair[0]) || typeof pair[1] !== "string") continue;
      const b = list.find((x) => x.id === pair[0] && x.team === team && !x.del);
      if (!b) continue;
      // Summed as peers see it: what never goes to a peer (forPeers) must not make the sums differ.
      const mine = forPeers(await elementsOf(b.id));
      if (sumOf(mine) !== pair[1]) void ch?.send({ t: "els", id: b.id, elements: mine }, from.id);
    }
    return;
  }
  if (msg.t === "list") {
    const r = mergeList(list, msg.boards, team, Date.now(), teamsView().find((t) => t.id === team)?.ownerId);
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
  if (msg.t === "view") {
    const v = viewers.get(board.id) ?? viewers.set(board.id, new Set()).get(board.id)!;
    if (msg.on === true) v.add(from.id); else { v.delete(from.id); dropCursor(board.id, from.id); }
    emit();
    return;
  }
  if (msg.t === "ping") {
    if (typeof msg.n === "number") void ch?.send({ t: "pong", id: board.id, n: msg.n }, from.id);
    return;
  }
  if (msg.t === "pong") {
    const sent = typeof msg.n === "number" ? pings.get(`${from.id}:${msg.n}`) : undefined;
    if (sent === undefined) return;
    pings.delete(`${from.id}:${msg.n}`);
    const ms = Math.round(performance.now() - sent);
    if (rtt.get(from.id) !== ms) { rtt.set(from.id, ms); emit(); }
    return;
  }
  if (msg.t === "ptr") {
    const api = open.get(board.id);
    if (!api || typeof msg.x !== "number" || typeof msg.y !== "number" || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    const c = cursors.get(board.id) ?? cursors.set(board.id, new Map()).get(board.id)!;
    c.set(from.id, { pointer: { x: msg.x, y: msg.y, tool: msg.tool === "laser" ? "laser" : "pointer" }, button: msg.button === "down" ? "down" : "up", username: from.name, id: from.id });
    api.updateScene({ collaborators: new Map(c) });
    return;
  }
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
// ---- who is looking at a shared board, and where their pointer is ----

/** Per board: the members who have it on screen now. */
const viewers = new Map<string, Set<string>>();
/** Per board on screen here: the others' pointers, as Excalidraw draws collaborators. */
const cursors = new Map<string, Map<string, any>>();

function dropCursor(id: string, member: string) {
  const c = cursors.get(id);
  if (!c?.delete(member)) return;
  open.get(id)?.updateScene({ collaborators: new Map(c) });
}
/** A member went offline: they look at nothing, and their pointers go. */
function gone(member: string) {
  rtt.delete(member);
  for (const [id, v] of viewers) { v.delete(member); dropCursor(id, member); }
  emit();
}

/** The others who have a shared board open now, with their last round trip in ms when known. */
export function boardViewers(id: string): Viewer[] {
  const ids = viewers.get(id);
  if (!ids?.size) return [];
  const members = teamsView().flatMap((t) => t.members);
  return [...ids].map((m) => ({ id: m, name: members.find((x) => x.id === m)?.name ?? "someone", ms: rtt.get(m) }));
}
export interface Viewer { id: string; name: string; ms?: number }

// ---- round trips to those looking at the same board, every 2 s while one is open here ----

/** Pings sent and not answered yet, by "<member>:<n>", with when they went (performance.now). */
const pings = new Map<string, number>();
/** Each member's last round trip, in ms. */
const rtt = new Map<string, number>();
let pingN = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
function pingViewers() {
  if (!open.size) { if (pingTimer) clearInterval(pingTimer); pingTimer = null; pings.clear(); return; }
  for (const id of open.keys()) {
    const b = list.find((x) => x.id === id && !x.del);
    const ch = b && chans.get(b.team);
    for (const m of viewers.get(id) ?? []) {
      const n = ++pingN;
      pings.set(`${m}:${n}`, performance.now());
      void ch?.send({ t: "ping", id, n }, m);
    }
  }
  // An answer that never came is not waited for.
  if (pings.size > 200) pings.clear();
}
/** Tell the team's members online whether this Deck has a shared board on screen. */
function sayView(id: string, on: boolean) {
  const b = list.find((x) => x.id === id && !x.del);
  if (b) void chans.get(b.team)?.send({ t: "view", id, on });
}

const lastPtr = new Map<string, { at: number; button: string }>();
/** This Deck's pointer on a shared board, to those who have it open: at most every 33 ms, and a
 *  press or release always, as a live share does. */
export function boardPointer(id: string, p: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }) {
  const b = list.find((x) => x.id === id && !x.del);
  const ch = b && chans.get(b.team);
  const to = viewers.get(id);
  if (!ch || !to?.size) return;
  const last = lastPtr.get(id);
  if (last && last.button === p.button && Date.now() - last.at < 33) return;
  lastPtr.set(id, { at: Date.now(), button: p.button });
  const msg = { t: "ptr", id, x: p.pointer.x, y: p.pointer.y, button: p.button, tool: p.pointer.tool };
  for (const m of to) void ch.send(msg, m);
}

export function attachBoard(id: string, api: any): () => void {
  open.set(id, api);
  // What it opened with is what this Deck has: only later changes are news.
  markSeen(api.getSceneElementsIncludingDeleted(), seenOf(id));
  sayView(id, true);
  pingTimer ??= setInterval(pingViewers, 2000);
  return () => {
    if (open.get(id) !== api) return;
    open.delete(id);
    cursors.delete(id);
    sayView(id, false);
  };
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
  const by = await myId();
  const b: TeamBoard = { id, name: name.slice(0, 200), team, rev: { t: Date.now(), by }, owner: by };
  await put(b);
  const ch = chans.get(team);
  if (ch?.online().length) await ch.send({ t: "els", id, elements: forPeers((await readJson(teamBoardKey(id)))?.elements ?? []) });
  return b;
}

export async function renameTeamBoard(id: string, name: string) {
  const b = list.find((x) => x.id === id);
  if (b) await put({ ...b, name: name.slice(0, 200), rev: { t: Math.max(Date.now(), b.rev.t + 1), by: await myId() } });
}

/** Whether this Deck may delete a shared board or stop sharing it (mayManage). */
export const canManage = (id: string) => {
  const b = list.find((x) => x.id === id);
  return !!b && mayManage(b, me, teamsView().find((t) => t.id === b.team)?.ownerId);
};

/** Delete a shared board for everyone in its team: only its owner or the team's owner. */
export async function deleteTeamBoard(id: string) {
  const b = list.find((x) => x.id === id);
  if (!b) return;
  await myId();
  if (!canManage(id)) return;
  await put({ ...b, del: true, rev: { t: Math.max(Date.now(), b.rev.t + 1), by: await myId() } });
  for (const k of [teamBoardKey(id), filesKey(teamBoardKey(id))]) void configWrite(k, "").catch(() => {});
}

/** Whose team a shared board is, by name, for its tab. */
export const teamName = (team: string) => teamsView().find((t) => t.id === team)?.name ?? "the team";

let unTeams: (() => void) | null = null;
let catchUp: ReturnType<typeof setInterval> | null = null;
/** What this Deck has, to each member online: the list, and a sum per board. */
async function catchUpNow() {
  for (const [team, ch] of chans) {
    if (!ch.online().length) continue;
    const mine = list.filter((b) => b.team === team);
    if (!mine.length) continue;
    const sums: [string, string][] = [];
    for (const b of mine) if (!b.del) sums.push([b.id, sumOf(forPeers(await elementsOf(b.id)))]);
    void ch.send({ t: "list", boards: mine });
    void ch.send({ t: "sum", sums });
  }
}
export async function startTeamBoards() {
  stopped = false;
  const t = await configRead(LIST).catch(() => "");
  if (stopped) return;
  listText = t;
  try { list = t.trim() ? JSON.parse(t) : []; } catch { list = []; }
  unTeams = subscribeTeams(channels);
  channels();
  catchUp = setInterval(() => void catchUpNow().catch((e) => console.warn("[canvas] the team boards catch-up failed", e)), CATCH_UP);
  // Who this Deck is, for canManage: only once it is in a team (asking makes an identity).
  if (teamsView().length) void myId().then(emit).catch(() => {});
}
export function stopTeamBoards() {
  stopped = true;
  unTeams?.(); unTeams = null;
  for (const ch of chans.values()) ch.close();
  chans.clear();
  timers.forEach(clearTimeout); timers.clear();
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (catchUp) clearInterval(catchUp);
  catchUp = null;
}
