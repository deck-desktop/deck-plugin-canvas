// What a shared board sends, as pure functions so the check can run them without a network.
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

/**
 * The share protocol's version, said in every hello. Decks on different versions do not share a
 * board: one would half-understand the other. Builds from before this field count as 1.
 */
export const SHARE_VERSION = 4;

/**
 * Who may draw on a shared board: a default for everyone, and a choice per person that wins over
 * it. The host decides, always can, and sends this to everyone; every Deck then ignores edits from
 * whoever may not draw, so a view-only Deck cannot change anyone's board even if it tried.
 */
export type Mode = "edit" | "view";
export interface Roles { def: Mode; per: Record<string, Mode> }
export const canDraw = (roles: Roles, peer: string, host: string | null) =>
  peer === host || (roles.per[peer] ?? roles.def) === "edit";

/**
 * A pencil stroke being drawn, cut down to the points added since `from`: what goes out while the
 * pen is down, instead of the whole stroke again on every send. `_from` marks it as a tail.
 */
export interface Stroke { id: string; points: unknown[]; pressures?: unknown[] }
export function strokeTail<T extends Stroke>(el: T, from: number): T & { _from: number } {
  return { ...el, points: el.points.slice(from), pressures: el.pressures?.slice(from), _from: from };
}

/**
 * A received tail put back together with the stroke as this side already has it. Null when this
 * side is missing points before the tail (a lost message): the tail is then skipped, and the
 * whole stroke, sent when the pen lifts, fills it in.
 */
export function joinStroke<T extends Stroke & { _from?: number }>(tail: T, have: Stroke | undefined): T | null {
  if (tail._from === undefined) return tail;
  if (!have || have.points.length < tail._from) return null;
  const { _from, ...rest } = tail;
  return {
    ...rest,
    points: have.points.slice(0, _from).concat(tail.points),
    pressures: tail.pressures && (have.pressures ?? []).slice(0, _from).concat(tail.pressures),
  } as T;
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

/** A share code: 16 random characters in four groups, easy to read out or paste. */
export function newCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: a code may be read aloud
  const chars = [...random(16)].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

/** A pasted code, tidied: spaces dropped, case folded. Empty when it is not a code. */
export function cleanCode(text: string): string {
  const c = text.trim().toLowerCase().replace(/\s+/g, "");
  return /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(c) ? c : "";
}
