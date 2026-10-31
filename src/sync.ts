// What a board shared with a team sends (teamboards.ts), as pure functions so the check can run them without a network.
//
// Every Excalidraw element carries a `version` that goes up on each edit, and Excalidraw's own
// reconcileElements merges two copies by it. So each side only needs to remember, per element,
// the highest version it has already sent or received: anything newer is a local edit to send,
// and anything at or below it is either already out or came from the other side. Remembering
// the received versions too is what stops an edit from bouncing back and forth forever, because
// applying a remote edit fires the same change event a local one does.

/** The part of an element this file reads. */
export interface Versioned { id: string; version: number }

/** Element id to the highest version already sent or received. */
export type Seen = Map<string, number>;

/** Record elements as already exchanged, so they are not sent (again). */
export function markSeen(elements: readonly Versioned[], seen: Seen): void {
  for (const e of elements) if (e.version > (seen.get(e.id) ?? -1)) seen.set(e.id, e.version);
}

/**
 * The elements edited since they were last exchanged, marked as exchanged. Deleted elements are
 * included: a deletion is an edit (`isDeleted` set, version bumped), and leaving them out would
 * mean a shape removed on one side stays on the other.
 */
export function takeChanged<T extends Versioned>(elements: readonly T[], seen: Seen): T[] {
  const out = elements.filter((e) => e.version > (seen.get(e.id) ?? -1));
  markSeen(out, seen);
  return out;
}

/** The parts of a picture and of an image element this file reads. */
export interface FileLike { id: string; dataURL: string }
export interface ImageRef { type?: string; fileId?: string | null; isDeleted?: boolean }

/**
 * The pictures to send: those an image on the board shows that have not gone out or come in
 * yet. One over `maxBytes` (the data URL's length, close to its size) is not sent but reported,
 * so the sender can say why the others see an empty frame. Either way it is marked, so it is
 * weighed once rather than on every change.
 */
export function takeNewFiles<F extends FileLike>(
  files: Record<string, F>, elements: readonly ImageRef[], done: Set<string>, maxBytes: number,
): { send: F[]; tooBig: F[] } {
  const send: F[] = [], tooBig: F[] = [];
  for (const e of elements) {
    if (e.isDeleted || e.type !== "image" || !e.fileId || done.has(e.fileId)) continue;
    const f = files[e.fileId];
    if (!f) continue; // still loading: a later change sends it
    done.add(f.id);
    (f.dataURL.length > maxBytes ? tooBig : send).push(f);
  }
  return { send, tooBig };
}

// ---- what crosses to and from another Deck (the security review's H1 and M6) ----
//
// A board's buttons are embeddable elements with a deck:// link that runs a command, a script or
// opens a file on this machine; another embeddable shows a web page inside Deck. Neither may come
// from someone else: a teammate's button would run their command here at a click, and their
// embedded page would be a site of their choosing drawn inside Deck. So those never arrive, and
// this Deck's own never leave (its commands are this machine's business). An ordinary element's
// link arrives only when it is a web or mail address, which opens in the browser as any link does.

/** Element types that embed something live rather than draw it. */
const EMBEDS = new Set(["embeddable", "iframe"]);
const SAFE_LINK = /^(https?:|mailto:)/i;

/** An element as this Deck takes it from another: none that embeds, and only a web or mail link. */
export function fromPeer<T extends { type?: string; link?: string | null }>(el: T): T | null {
  if (!el || typeof el !== "object" || EMBEDS.has(String(el.type))) return null;
  return el.link && !SAFE_LINK.test(String(el.link).trim()) ? { ...el, link: null } : el;
}

/** The elements this Deck sends: its buttons and embedded pages stay here. */
export const forPeers = <T extends { type?: string }>(els: readonly T[]): T[] => els.filter((e) => !EMBEDS.has(String(e.type)));
