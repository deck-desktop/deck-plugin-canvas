// A share that outlives the Canvas tab.
//
// Deck unmounts a pane you are not looking at: another tab, another workspace. A share held in the
// board component ended with it, so switching away dropped everyone and coming back meant joining
// again. This keeps the share at module scope instead, the way Deck keeps a terminal's shell
// running while its tab is hidden (core/terminals.ts).
//
// While the board is on screen, its Excalidraw API is attached and the share reads and writes the
// scene through it. While it is not, the share keeps the last scene the board showed and applies
// what arrives to that copy; the host also saves it, as the board would have. Coming back, the
// board opens from that copy and attaches again, so nothing that happened meanwhile is missing.
//
// Who is in, who may draw, removing someone and how a share ends are Deck's (p2p in window.__deck,
// src/core/p2p.ts). This file is what a board adds on top: keeping two Excalidraw scenes the same.
import { serializeAsJSON, reconcileElements, CaptureUpdateAction, getSceneVersion } from "@excalidraw/excalidraw";
import { configWrite } from "../shim/bridge.js";
import { notify, dismissNotification } from "../shim/ui.js";
import { share as startShare, type Json, type Mode, type P2pShare, type ShareView } from "../shim/p2p.js";
import { joinStroke, markSeen, strokeTail, takeChanged, takeNewFiles, SHARE_VERSION, type Seen } from "./sync";

/** A share: the room's code, which side this Deck is, its name. */
export interface Share {
  code: string; host: boolean; name: string;
  /** Bumped by Rejoin: the same room again, a fresh connection, the board left as it is. */
  attempt?: number;
  /** The host's choice when sharing: whether the others may draw. Changeable while shared. */
  mode?: Mode;
}

/** What travels between Decks on a shared board, beside Deck's own share messages. */
type BoardMsg =
  /** The whole board, from the host to someone just let in. */
  | { t: "scene"; elements: Json[] }
  /** Elements edited since the last message. */
  | { t: "update"; elements: Json[] }
  /** Pictures that image elements show, as Excalidraw keeps them (id, mimeType, dataURL, created). */
  | { t: "files"; files: Json[] }
  /** Where someone's pointer is, for the cursor drawn on everyone else's board. With the laser
   *  tool, Excalidraw draws the trail on the others' boards while the button is down. */
  | { t: "pointer"; x: number; y: number; button: "up" | "down"; tool: "pointer" | "laser" };

/** What the bar and dialogs show: Deck's share view (who is here, who is knocking, who may draw,
 *  how it ended). */
export type LiveView = ShareView;

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
/** The largest picture sent to the others; a bigger one stays an empty frame on their boards. */
const MAX_PICTURE = 4 * 1024 * 1024;

const filesKey = (key: string) => `${key}-files`;

/** The board as last seen on screen, kept while it is not. */
interface Scene { elements: any[]; appState: any; files: Record<string, any> }

export class LiveShare {
  readonly share: Share;
  /** Where the host's board is saved; empty on a guest, whose board is never saved. */
  readonly boardKey: string;
  private s: P2pShare<BoardMsg>;
  private api: any = null;
  /** The scene while the board is off screen (and the last one seen while it is on). */
  private scene: Scene;

  // Per element, the highest version sent or received: see sync.ts.
  private seen: Seen = new Map();
  // Pictures already sent or received, so each goes out once (see takeNewFiles).
  private filesDone: Set<string>;
  private cursors = new Map<string, any>();
  // The pencil stroke being drawn: how many of its points the others already have (strokeTail).
  private strokeSent = new Map<string, number>();
  private inFlight = false;
  private sendQueued = false;
  private lastSent = 0;
  private fullSynced = -1;
  private syncTimer: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** The board's name, for the notification saying someone wants to join it. */
  private boardName: string;
  // People whose request to join is up as a notification, by peer id, so a view change (a ping
  // measured) does not post it again with another chime. Taken down once they are let in, turned
  // away (from the notification or the board's bar), give up, or the share ends.
  private knockNotes = new Set<string>();

  constructor(share: Share, boardKey: string, boardName: string, scene: Scene) {
    this.share = share;
    this.boardKey = share.host ? boardKey : "";
    this.boardName = boardName;
    this.scene = scene;
    // What is on the board now is what someone let in gets in full, not an edit to broadcast;
    // the same for its pictures, which go to them in their welcome.
    markSeen(scene.elements, this.seen);
    this.filesDone = new Set(Object.keys(scene.files));
    this.s = startShare<BoardMsg>(
      // "board" was Canvas's one channel before sharing moved into Deck; kept as the name of its own.
      { app: "canvas-share", channel: "board", code: share.code, host: share.host, name: share.name, version: SHARE_VERSION, mode: share.mode },
      {
        message: (msg, peer) => this.onMessage(msg, peer),
        welcome: (peer) => this.welcome(peer),
        left: (peer) => { this.cursors.delete(peer); this.showCursors(); },
      },
    );
    // Ended for this Deck (the host stopped, left or removed it): stop the board's side too. The
    // board stays on screen until the guest chooses what to keep.
    this.s.subscribe(() => {
      if (this.view.gone) void this.close();
      this.notifyKnocks();
    });
    this.syncTimer = setInterval(() => this.fullSync(), FULL_SYNC_MS);
  }

  matches(share: Share) {
    return !this.closed && share.code === this.share.code && (share.attempt ?? 0) === (this.share.attempt ?? 0);
  }

  // ---- The board, on screen or not ----

  /** The board came on screen: read and write through its Excalidraw API from now on. */
  attach(api: any) {
    this.api = api;
    this.showCursors();
    // On screen, the board's own bar shows who is asking: the notifications would say it twice.
    this.notifyKnocks();
  }

  /** The board went off screen: keep working on the last scene it showed. */
  detach(api: any) {
    if (this.api === api) this.api = null;
    this.notifyKnocks();
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
    if (this.boardKey) void configWrite(filesKey(this.boardKey), JSON.stringify(files)).catch((e) => console.warn("[canvas] pictures save failed", e));
  }

  /** Off screen, the host's board is still saved as edits arrive, as it would be on screen. */
  private saveOffScreen() {
    if (!this.boardKey) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.api || this.closed) return; // back on screen: the board saves itself
      const json = serializeAsJSON(this.scene.elements.filter((e) => !e.isDeleted), this.scene.appState ?? {}, {}, "local");
      void configWrite(this.boardKey, json).catch((e) => console.warn("[canvas] board save failed", e));
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
    if (tooBig.length) this.s.say(`${tooBig.length === 1 ? "A picture is" : `${tooBig.length} pictures are`} too big to share (over 4 MB)`);
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
    if (this.closed || !this.view.peers.length || !this.view.canEdit) return;
    const all = this.elements();
    const v = getSceneVersion(all);
    if (v === this.fullSynced) return;
    this.fullSynced = v;
    void this.s.send({ t: "update", elements: all });
  }

  // ---- Receiving ----

  private onMessage(msg: BoardMsg, peer: string) {
    if (this.closed) return;
    // Edits from someone who may not draw are dropped, by every Deck, not only the host's.
    if (msg.t !== "pointer" && !this.s.mayEdit(peer)) return;
    if (msg.t === "files") {
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
    } else if (msg.t === "pointer") {
      const username = this.view.peers.find((p) => p.id === peer)?.name ?? "someone";
      this.cursors.set(peer, { pointer: { x: msg.x, y: msg.y, tool: msg.tool ?? "pointer" }, button: msg.button, username, id: peer });
      this.showCursors();
    }
  }

  /** The board and its pictures, to someone just let in. */
  private welcome(peer: string) {
    void this.s.send({ t: "scene", elements: this.elements() }, peer);
    const { send } = takeNewFiles(this.files(), this.liveElements(), new Set(), MAX_PICTURE);
    for (const f of send) void this.s.send({ t: "files", files: [f as any] }, peer);
  }

  /** Someone asking to join, as a notification with Let in and Deny on it: on screen or not, the
   *  board's bar is no use while Deck is behind another window, and Deck reaches Windows then. */
  /** Join requests as Deck notifications, only while the board is off screen: on it, its bar asks. */
  private notifyKnocks() {
    const knocking = this.closed || this.api ? [] : this.view.knocking;
    for (const id of this.knockNotes) {
      if (knocking.some((p) => p.id === id)) continue;
      dismissNotification("Canvas", id);
      this.knockNotes.delete(id);
    }
    for (const p of knocking) {
      if (this.knockNotes.has(p.id)) continue;
      this.knockNotes.add(p.id);
      notify({
        kind: "attention", source: "Canvas", key: p.id,
        title: `${p.name} wants to join ${this.boardName}`,
        actions: [{ label: "Let in", primary: true, run: () => this.allow(p.id) }, { label: "Deny", run: () => this.deny(p.id) }],
      });
    }
  }

  private showCursors() { this.api?.updateScene({ collaborators: new Map(this.cursors) }); }

  // ---- People: Deck's share decides; the bar calls these ----

  get view(): LiveView { return this.s.getView(); }
  subscribe = (fn: () => void) => this.s.subscribe(fn);
  getView = () => this.s.getView();
  allow(peer: string) { this.s.allow(peer); }
  deny(peer: string) { this.s.deny(peer); }
  kick(peer: string) { this.s.kick(peer); }
  setDefault(def: Mode) { this.s.setDefault(def); }
  setPerson(peer: string, mode: Mode | null) { this.s.setPerson(peer, mode); }

  // ---- Ending ----

  /** Leave; with `announce` (the host ending on purpose) tell everyone first. */
  async close(announce = false) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.syncTimer);
    this.cursors.clear();
    this.notifyKnocks();
    this.showCursors();
    await this.s.close(announce);
  }
}
