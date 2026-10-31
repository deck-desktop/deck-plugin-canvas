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
const { markSeen, takeChanged, takeNewFiles, fromPeer, forPeers } = await import(`file://${out}`);
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

// Another Deck's buttons and embedded pages never arrive (H1, M6); a link only as a web or mail address.
assert.equal(fromPeer({ id: "b", type: "embeddable", link: "deck://term/rm%20-rf%20~" }), null);
assert.equal(fromPeer({ id: "w", type: "embeddable", link: "https://evil.example" }), null);
assert.equal(fromPeer({ id: "i", type: "iframe" }), null);
assert.equal(fromPeer({ id: "r", type: "rectangle", link: "deck://script/x" }).link, null);
assert.equal(fromPeer({ id: "r", type: "rectangle", link: "javascript:alert(1)" }).link, null);
assert.equal(fromPeer({ id: "r", type: "rectangle", link: "https://ok.example" }).link, "https://ok.example");
assert.deepEqual(fromPeer({ id: "t", type: "text" }), { id: "t", type: "text" });
// This Deck's own buttons and embeds stay here.
assert.deepEqual(forPeers([{ id: "a", type: "rectangle" }, { id: "b", type: "embeddable" }, { id: "c", type: "iframe" }]).map((e) => e.id), ["a"]);

console.log("canvas sync ok");
