// A share that outlives the Canvas tab.
//
// Deck unmounts a pane you are not looking at: another tab, another workspace. A share held in the
// board component ended with it, so switching away dropped everyone and coming back meant typing
// the code and password again. This keeps the share at module scope instead, the way Deck keeps a
// terminal's shell running while its tab is hidden (core/terminals.ts).
//
// While the board is on screen, its Excalidraw API is attached and the share reads and writes the
// scene through it. While it is not, the share keeps the last scene the board showed and applies
// what arrives to that copy; the host also saves it, as the board would have. Coming back, the
// board opens from that copy and attaches again, so nothing that happened meanwhile is missing.
import { serializeAsJSON, reconcileElements, CaptureUpdateAction, getSceneVersion } from "@excalidraw/excalidraw";
import { configWrite } from "../shim/bridge.js";
import { connect, selfId, type Session, type ShareMsg } from "./share";
import { canDraw, joinStroke, markSeen, strokeTail, takeChanged, takeNewFiles, SHARE_VERSION, type Mode, type Roles, type Seen } from "./sync";

/** A share: the room's code, the password the host set, which side this Deck is, its name. */
export interface Share {
  code: string; password: string; host: boolean; name: string;
  /** Bumped by Rejoin: the same room again, a fresh connection, the board left as it is. */
  attempt?: number;
  /** The host's choice when sharing: whether the others may draw. Changeable while shared. */
  mode?: Mode;
}

export type HostGone = "ended" | "lost" | "removed" | "version";

/** What the bar and dialogs show. Replaced, never mutated, so React sees a change. */
export interface LiveView {
  peers: { id: string; name: string; ms?: number }[];
  /** A guest that has heard nothing from a host for a while. */
  stuck: boolean;
  /** On a guest: the host stopped, vanished, removed this Deck, or speaks another version. */
  hostGone: HostGone | null;
  hostName: string;
  /** A passing line: a picture too big to send, someone on another version. */
  note: string;
  /** Who may draw (see sync.ts), and whether this Deck may. */
  roles: Roles;
  canEdit: boolean;
}

/**
 * Edits go out at most this often, and never while the last batch is still on its way: whatever
 * changed in the meantime goes in the next one. A pencil stroke is one element whose points grow
 * with every move, and it used to go out whole on every frame: one 300-point stroke was 301
 * messages and 2MB, enough to back the connection up and lag everything behind it.
 */
const SEND_MS = 50;
/** The same while a pencil stroke is being drawn, the heaviest element to resend. */
const SEND_DRAWING_MS = 100;
/**
 * How often the whole board goes out while shared. When two people move the same shape at once,
 * Excalidraw keeps whichever is being edited on each screen and drops the other's, and nothing
 * sends that shape again until someone touches it: the two boards drift apart. Sending everything
 * now and then lets the newest version of every shape win everywhere, as excalidraw.com does.
 */
const FULL_SYNC_MS = 15000;
/** How often each connection's round trip is measured, for the number the bar shows. */
const PING_MS = 3000;
/** The largest picture sent to the others; a bigger one stays an empty frame on their boards. */
const MAX_PICTURE = 4 * 1024 * 1024;
/** How long a guest waits to hear from a host before saying it can't reach the board. */
const STUCK_MS = 20000;

const filesKey = (key: string) => `${key}-files`;

/** The board as last seen on screen, kept while it is not. */
interface Scene { elements: any[]; appState: any; files: Record<string, any> }

export class LiveShare {
  readonly share: Share;
  /** Where the host's board is saved; empty on a guest, whose board is never saved. */
  readonly boardKey: string;
  private s: Session;
  private api: any = null;
  /** The scene while the board is off screen (and the last one seen while it is on). */
  private scene: Scene;
  private listeners = new Set<() => void>();
  view: LiveView;

  // Per element, the highest version sent or received: see sync.ts.
  private seen: Seen = new Map();
  // Pictures already sent or received, so each goes out once (see takeNewFiles).
  private filesDone: Set<string>;
  // Peers whose hello showed the same share version: nothing else from a peer is read before it.
  private verified = new Set<string>();
  // Peers the host removed: not drawn, not listened to.
  private kicked = new Set<string>();
  private hostPeer: string | null = null;
  private names = new Map<string, string>();
  private pings = new Map<string, number>();
  private cursors = new Map<string, any>();
  // The pencil stroke being drawn: how many of its points the others already have (strokeTail).
  private strokeSent = new Map<string, number>();
  private inFlight = false;
  private sendQueued = false;
  private lastSent = 0;
  private fullSynced = -1;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stuckTimer?: ReturnType<typeof setTimeout>;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(share: Share, boardKey: string, scene: Scene) {
    this.share = share;
    this.boardKey = share.host ? boardKey : "";
    // A guest draws until the host says otherwise, which it does as the guest joins.
    const roles: Roles = { def: share.host ? share.mode ?? "edit" : "edit", per: {} };
    this.view = { peers: [], stuck: false, hostGone: null, hostName: "the host", note: "", roles, canEdit: true };
    this.scene = scene;
    // What is on the board now is what a joining peer gets in full, not an edit to broadcast;
    // the same for its pictures, which go to a joiner in its welcome.
    markSeen(scene.elements, this.seen);
    this.filesDone = new Set(Object.keys(scene.files));
    if (!share.host) this.stuckTimer = setTimeout(() => { if (!this.hostPeer) this.set({ stuck: true }); }, STUCK_MS);
    this.s = connect(share.code, share.password, {
      message: (msg, peer) => this.onMessage(msg, peer),
      join: (peer) => {
        if (this.kicked.has(peer)) return; // back with the same id: not let in again
        this.refreshPeers();
        void this.s.send({ t: "hello", name: share.name, host: share.host, v: SHARE_VERSION }, peer);
      },
      leave: (peer) => {
        // The host's connection dropped without a goodbye (Deck closed, network gone).
        if (!share.host && peer === this.hostPeer) { this.hostLeft("lost"); return; }
        this.drop(peer, false);
      },
    });
    this.timers.push(setInterval(() => this.fullSync(), FULL_SYNC_MS));
    this.timers.push(setInterval(() => this.measure(), PING_MS));
  }

  matches(share: Share) {
    return !this.closed && share.code === this.share.code && share.password === this.share.password
      && (share.attempt ?? 0) === (this.share.attempt ?? 0);
  }

  // ---- The board, on screen or not ----

  /** The board came on screen: read and write through its Excalidraw API from now on. */
  attach(api: any) {
    this.api = api;
    this.showCursors();
  }

  /** The board went off screen: keep working on the last scene it showed. */
  detach(api: any) {
    if (this.api === api) this.api = null;
  }

  /** Called from the board's onChange, so the copy kept for off screen is always the latest. */
  seenOnScreen(elements: readonly any[], appState: any, files: Record<string, any>) {
    this.scene = { elements: elements as any[], appState, files };
  }

  /** The scene to open the board from when it comes back on screen. */
  get current(): Scene { return this.scene; }

  private elements(): any[] { return this.api ? this.api.getSceneElementsIncludingDeleted() : this.scene.elements; }
  private liveElements(): any[] { return this.api ? this.api.getSceneElements() : this.scene.elements.filter((e) => !e.isDeleted); }
  private files(): Record<string, any> { return this.api ? this.api.getFiles() ?? {} : this.scene.files; }

  private apply(remote: any[], fit: boolean) {
    if (this.api) {
      const merged = reconcileElements(this.api.getSceneElementsIncludingDeleted(), remote, this.api.getAppState());
      // NEVER: an edit made on the other Deck is not one this side's undo should take back.
      this.api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      if (fit) this.api.scrollToContent(undefined, { fitToContent: true });
    } else {
      // A fresh appState, not the one kept from the screen: that may still say an element is being
      // edited (the board was left mid-edit), and reconcile would keep refusing others' edits to it
      // for as long as the board is off screen.
      this.scene = { ...this.scene, elements: reconcileElements(this.scene.elements, remote, {} as any) as any[] };
      this.saveOffScreen();
    }
  }

  private addFiles(got: any[]) {
    if (this.api) { this.api.addFiles(got); return; }
    const files = { ...this.scene.files };
    for (const f of got) files[f.id] = f;
    this.scene = { ...this.scene, files };
    if (this.boardKey) void configWrite(filesKey(this.boardKey), JSON.stringify(files)).catch(() => {});
  }

  /** Off screen, the host's board is still saved as edits arrive, as it would be on screen. */
  private saveOffScreen() {
    if (!this.boardKey) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.api || this.closed) return; // back on screen: the board saves itself
      const json = serializeAsJSON(this.scene.elements.filter((e) => !e.isDeleted), this.scene.appState ?? {}, {}, "local");
      void configWrite(this.boardKey, json).catch(() => {});
    }, 800);
  }

  // ---- Sending ----

  /** Paced: see SEND_MS. A change while a batch is in flight, or too soon after the last, waits and
   *  goes out with whatever else changed by then. */
  queueSend() {
    if (this.closed || this.sendQueued) return;
    this.sendQueued = true;
    const drawing = this.api?.getAppState().newElement?.type === "freedraw";
    setTimeout(() => this.flush(), Math.max(0, this.lastSent + (drawing ? SEND_DRAWING_MS : SEND_MS) - Date.now()));
  }

  private flush() {
    if (this.inFlight) { setTimeout(() => this.flush(), 16); return; }
    this.sendQueued = false;
    const api = this.api;
    // A view-only Deck sends no edits: the others would drop them anyway.
    if (this.closed || !api || !this.view.canEdit) return;
    this.lastSent = Date.now();
    const all = api.getSceneElementsIncludingDeleted();
    const drawing = api.getAppState().newElement;
    const drawingId = drawing?.type === "freedraw" ? drawing.id : null;
    // While the pen is down, a stroke goes out as just its new points. Once it lifts, the whole
    // stroke goes out once more, edited since or not, so a tail lost on the way is made good.
    const out: any[] = takeChanged(all, this.seen).map((e: any) => {
      if (e.id !== drawingId) return e;
      const from = this.strokeSent.get(e.id);
      this.strokeSent.set(e.id, e.points.length);
      return from === undefined ? e : strokeTail(e, from);
    });
    for (const id of [...this.strokeSent.keys()]) {
      if (id === drawingId) continue;
      this.strokeSent.delete(id);
      const done = all.find((e: any) => e.id === id);
      if (done && !out.some((e) => e.id === id)) out.push(done);
    }
    if (out.length) {
      this.inFlight = true;
      void this.s.send({ t: "update", elements: out }).finally(() => { this.inFlight = false; });
    }
    const { send, tooBig } = takeNewFiles(api.getFiles() ?? {}, api.getSceneElements(), this.filesDone, MAX_PICTURE);
    // One message each: a picture can be megabytes, and Trystero splits a message into chunks
    // that all have to arrive before any of it is read.
    for (const f of send) void this.s.send({ t: "files", files: [f as any] });
    if (tooBig.length) this.say(`${tooBig.length === 1 ? "A picture is" : `${tooBig.length} pictures are`} too big to share (over 4 MB)`);
  }

  private lastPointer = 0;
  private lastButton: "up" | "down" = "up";
  /** Pointer moves, at most every 33ms; a press or release always, so a laser trail on the
   *  others' boards starts and ends where it did here. */
  pointer(p: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }) {
    const changed = p.button !== this.lastButton;
    this.lastButton = p.button;
    if (this.closed || (!changed && Date.now() - this.lastPointer < 33)) return;
    this.lastPointer = Date.now();
    void this.s.send({ t: "pointer", x: p.pointer.x, y: p.pointer.y, button: p.button, tool: p.pointer.tool });
  }

  /** The whole board now and then, but only when it changed since the last time: see FULL_SYNC_MS. */
  private fullSync() {
    if (this.closed || !this.verified.size || !this.view.canEdit) return;
    const all = this.elements();
    const v = getSceneVersion(all);
    if (v === this.fullSynced) return;
    this.fullSynced = v;
    void this.s.send({ t: "update", elements: all });
  }

  private measure() {
    for (const p of this.verified) {
      if (this.kicked.has(p)) continue;
      this.s.ping(p).then((ms) => {
        if (this.pings.get(p) === Math.round(ms)) return;
        this.pings.set(p, Math.round(ms));
        this.refreshPeers();
      }).catch(() => {});
    }
  }

  // ---- Receiving ----

  private onMessage(msg: ShareMsg, peer: string) {
    if (this.closed || this.kicked.has(peer)) return;
    // Until its hello shows it speaks this version, a peer is only heard saying hello.
    if (msg.t !== "hello" && !this.verified.has(peer)) return;
    // Edits from someone who may not draw are dropped, by every Deck, not only the host's.
    if ((msg.t === "update" || msg.t === "files" || msg.t === "scene") && !canDraw(this.view.roles, peer, this.share.host ? null : this.hostPeer)) return;
    if (msg.t === "roles") {
      if (peer !== this.hostPeer) return; // only the host decides
      this.setRoles({ def: msg.def, per: msg.per });
    } else if (msg.t === "files") {
      const got = msg.files as any[];
      for (const f of got) this.filesDone.add(f.id);
      this.addFiles(got);
    } else if (msg.t === "scene" || msg.t === "update") {
      // A stroke's tail is joined to the stroke as this side has it; one that cannot be (a tail
      // before it was lost) is skipped, and the whole stroke follows when the pen lifts.
      const have = new Map(this.elements().map((e: any) => [e.id, e]));
      const remote = (msg.elements as any[]).map((e) => joinStroke(e, have.get(e.id) as any)).filter(Boolean) as any[];
      // Recorded before the scene changes, so the change event this fires sends none of it back.
      markSeen(remote, this.seen);
      this.apply(remote, msg.t === "scene");
    } else if (msg.t === "hello") {
      if ((msg.v ?? 1) !== SHARE_VERSION) {
        // The host on another version ends this for the guest; anyone else is left out.
        if (msg.host && !this.share.host) { this.set({ hostName: msg.name }); this.hostLeft("version"); }
        else { this.drop(peer); this.say(`${msg.name} has a different Canvas version and was not let in`); }
        return;
      }
      this.verified.add(peer);
      this.names.set(peer, msg.name);
      if (msg.host) { this.hostPeer = peer; this.set({ hostName: msg.name, stuck: false }); }
      if (this.share.host && !msg.host) this.welcome(peer);
      const c = this.cursors.get(peer);
      if (c) { this.cursors.set(peer, { ...c, username: msg.name }); this.showCursors(); }
      this.refreshPeers();
    } else if (msg.t === "end") {
      if (!this.share.host) this.hostLeft("ended");
    } else if (msg.t === "kick") {
      if (peer !== this.hostPeer) return; // only the host removes anyone
      if (msg.peer === selfId) this.hostLeft("removed");
      else this.drop(msg.peer);
    } else if (msg.t === "pointer") {
      const username = this.names.get(peer) ?? "someone";
      this.cursors.set(peer, { pointer: { x: msg.x, y: msg.y, tool: msg.tool ?? "pointer" }, button: msg.button, username, id: peer });
      this.showCursors();
    }
  }

  /** The board and its pictures, to a joiner whose version checked out. */
  private welcome(peer: string) {
    void this.s.send({ t: "roles", ...this.view.roles }, peer);
    void this.s.send({ t: "scene", elements: this.elements() }, peer);
    const { send } = takeNewFiles(this.files(), this.liveElements(), new Set(), MAX_PICTURE);
    for (const f of send) void this.s.send({ t: "files", files: [f as any] }, peer);
  }

  // ---- Who may draw (the host) ----

  /** The default for everyone. */
  setDefault(def: Mode) { this.changeRoles({ ...this.view.roles, def }); }

  /** One person's own choice, or `null` to follow the default again. */
  setPerson(peer: string, mode: Mode | null) {
    const per = { ...this.view.roles.per };
    if (mode === null) delete per[peer]; else per[peer] = mode;
    this.changeRoles({ ...this.view.roles, per });
  }

  private changeRoles(roles: Roles) {
    if (!this.share.host) return;
    this.setRoles(roles);
    void this.s.send({ t: "roles", ...roles });
  }

  private setRoles(roles: Roles) {
    const canEdit = this.share.host || (roles.per[selfId] ?? roles.def) === "edit";
    this.set({ roles, canEdit });
  }

  // ---- People ----

  /** Remove someone from the board (the host only). */
  kick(peer: string) {
    void this.s.send({ t: "kick", peer });
    this.drop(peer);
  }

  /** Forget a peer that left, or that the host removed (`kick`: not let back in). */
  private drop(peer: string, kick = true) {
    if (kick) this.kicked.add(peer);
    this.names.delete(peer);
    this.pings.delete(peer);
    this.cursors.delete(peer);
    this.showCursors();
    this.refreshPeers();
  }

  private refreshPeers() {
    const peers = this.s.peers().filter((p) => !this.kicked.has(p))
      .map((id) => ({ id, name: this.names.get(id) ?? "someone", ms: this.pings.get(id) }));
    this.set({ peers });
  }

  private showCursors() { this.api?.updateScene({ collaborators: new Map(this.cursors) }); }

  /** A guest whose host has gone: stop talking, keep the board until they choose. */
  private hostLeft(why: HostGone) {
    void this.close();
    this.set({ hostGone: why });
  }

  private say(note: string) {
    this.set({ note });
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.set({ note: "" }), 6000);
  }

  // ---- Ending ----

  /** Leave the room; with `announce` (the host ending on purpose) tell everyone first. */
  async close(announce = false) {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.stuckTimer);
    clearTimeout(this.noteTimer);
    this.cursors.clear();
    this.showCursors();
    await this.s.close(announce);
  }

  // ---- For React (useSyncExternalStore) ----

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getView = () => this.view;
  private set(part: Partial<LiveView>) {
    this.view = { ...this.view, ...part };
    this.listeners.forEach((f) => f());
  }
}
