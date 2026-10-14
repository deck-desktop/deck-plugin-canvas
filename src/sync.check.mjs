// What a shared board sends, checked without the app or a network.
//
//   node plugins/canvas/src/sync.check.mjs
//
// Compiled from the real source with esbuild, as the other checks are, so it fails when sync.ts
// changes rather than when a copy of it does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "deck-canvas-sync-"));
const out = join(dir, "sync.mjs");
await build({ entryPoints: [join(import.meta.dirname, "sync.ts")], outfile: out, format: "esm", bundle: false });
const { markSeen, takeChanged, takeNewFiles, SHARE_VERSION, strokeTail, joinStroke } = await import(`file://${out}`);
rmSync(dir, { recursive: true, force: true });

const el = (id, version, extra = {}) => ({ id, version, ...extra });

// What is on the board when sharing starts goes to a joiner whole, not out as edits.
const seen = new Map();
markSeen([el("a", 3), el("b", 1)], seen);
assert.deepEqual(takeChanged([el("a", 3), el("b", 1)], seen), []);

// A local edit goes out once, then not again.
assert.deepEqual(takeChanged([el("a", 4), el("b", 1)], seen).map((e) => e.id), ["a"]);
assert.deepEqual(takeChanged([el("a", 4), el("b", 1)], seen), []);

// A new shape goes out; so does a deletion, which is an edit like any other.
const changed = takeChanged([el("a", 4), el("b", 2, { isDeleted: true }), el("c", 1)], seen);
assert.deepEqual(changed.map((e) => e.id), ["b", "c"]);
assert.equal(changed[0].isDeleted, true);

// An edit received from the other side is not sent back when applying it fires a change.
markSeen([el("a", 9)], seen);
assert.deepEqual(takeChanged([el("a", 9), el("b", 2), el("c", 1)], seen), []);
// ... but this side editing it again afterwards is.
assert.deepEqual(takeChanged([el("a", 10)], seen).map((e) => e.id), ["a"]);

// An older copy arriving late never lowers what has been seen.
markSeen([el("a", 2)], seen);
assert.equal(seen.get("a"), 10);

// Pictures: only those an image on the board shows, once each, and the big ones held back.
const files = { p1: { id: "p1", dataURL: "x".repeat(10) }, p2: { id: "p2", dataURL: "x".repeat(500) }, spare: { id: "spare", dataURL: "x" } };
const done = new Set();
const imgs = [
  { type: "image", fileId: "p1" }, { type: "image", fileId: "p2" }, { type: "rectangle" },
  { type: "image", fileId: "gone", isDeleted: true }, { type: "image", fileId: "loading" },
];
let r = takeNewFiles(files, imgs, done, 100);
assert.deepEqual(r.send.map((x) => x.id), ["p1"]);
assert.deepEqual(r.tooBig.map((x) => x.id), ["p2"]);
assert.deepEqual(takeNewFiles(files, imgs, done, 100), { send: [], tooBig: [] }, "each weighed once");
// One received from the other side counts as done.
done.add("p3");
assert.deepEqual(takeNewFiles({ p3: { id: "p3", dataURL: "x" } }, [{ type: "image", fileId: "p3" }], done, 100).send, []);
// A picture still loading goes out on a later change, once it is there.
assert.deepEqual(takeNewFiles({ loading: { id: "loading", dataURL: "x" } }, imgs, done, 100).send.map((x) => x.id), ["loading"]);
assert.equal(SHARE_VERSION, 5);

// Pencil strokes: the tail goes out, and is joined back onto what the other side has.
const stroke = { id: "s", version: 9, points: [[0, 0], [1, 1], [2, 2], [3, 3]], pressures: [0.1, 0.2, 0.3, 0.4] };
const tail = strokeTail(stroke, 2);
assert.deepEqual(tail.points, [[2, 2], [3, 3]]);
assert.deepEqual(tail.pressures, [0.3, 0.4]);
assert.equal(tail._from, 2);
const have = { id: "s", points: [[0, 0], [1, 1]], pressures: [0.1, 0.2] };
const joined = joinStroke(tail, have);
assert.deepEqual(joined.points, stroke.points);
assert.deepEqual(joined.pressures, stroke.pressures);
assert.equal(joined.version, 9);
assert.equal("_from" in joined, false, "a joined stroke is a plain element again");
// This side has extra points from an earlier tail that was replaced: the tail wins from _from on.
assert.deepEqual(joinStroke(tail, { id: "s", points: [[0, 0], [1, 1], [9, 9]], pressures: [0.1, 0.2, 0.9] }).points, stroke.points);
// Missing points before the tail (a lost message), or no stroke at all: skipped.
assert.equal(joinStroke(tail, { id: "s", points: [[0, 0]] }), null);
assert.equal(joinStroke(tail, undefined), null);
// A whole element passes through untouched.
assert.equal(joinStroke(stroke, undefined), stroke);
// A stroke without pressures (a mouse) stays without.
assert.equal(joinStroke(strokeTail({ id: "m", points: [[0, 0], [1, 1]] }, 1), { id: "m", points: [[0, 0]] }).pressures, undefined);

console.log("canvas sync ok");
