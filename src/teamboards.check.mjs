// Boards always shared with a team (teamboards.ts), checked without the app or a network: which
// list entry wins, that a delete sticks, and what another Deck's message may hold.
//
//   node src/teamboards.check.mjs
//
// Compiled from the real source with esbuild, as sync.check.mjs is; Excalidraw and Deck's shim are
// stood in for, since only the pure parts are checked here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "deck-canvas-teamboards-"));
const out = join(dir, "teamboards.mjs");
await build({
  entryPoints: [join(import.meta.dirname, "teamboards.ts")], outfile: out, format: "esm", bundle: true, logLevel: "silent",
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^(@excalidraw\/excalidraw|\.\.\/shim\/.*)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
      export const CaptureUpdateAction = {}; export const reconcileElements = (a) => a;
      export const configRead = async () => ""; export const configWrite = async () => {};
      export const myTeamId = async () => "me"; export const subscribeTeams = () => () => {};
      export const teamChannel = () => ({}); export const teamsView = () => [];` }));
  } }],
});
const T = await import(`file://${out}`);
rmSync(dir, { recursive: true, force: true });

const now = 1_000_000;
const b = (id, t, extra = {}) => ({ id, name: `Board ${id}`, team: "t1", rev: { t, by: "x" }, ...extra });

// A board another Deck has is taken; a newer rename wins, an older one does not.
let r = T.mergeList([], [b("b1", 10)], "t1", now);
assert.deepEqual(r.changed, ["b1"]);
r = T.mergeList(r.list, [b("b1", 20, { name: "Plan" })], "t1", now);
assert.equal(r.list[0].name, "Plan");
assert.deepEqual(T.mergeList(r.list, [b("b1", 15, { name: "Old" })], "t1", now).changed, []);
// A delete is a newer entry: it sticks, and an older copy of the board does not bring it back.
r = T.mergeList(r.list, [b("b1", 30, { del: true })], "t1", now);
assert.equal(r.list[0].del, true);
assert.deepEqual(T.mergeList(r.list, [b("b1", 25)], "t1", now).changed, [], "a deleted board came back");
// Only the team the message came from: a board said to be another team's is not taken from it.
assert.deepEqual(T.mergeList([], [b("b2", 10, { team: "other" })], "t1", now).changed, []);
// What is refused: an id that is a path, a revision from far in the future, the wrong shape.
assert.equal(T.cleanBoard(b("../x", 10), now), null);
assert.equal(T.cleanBoard(b("b3", now + 24 * 3600_000), now), null);
assert.equal(T.cleanBoard({ ...b("b3", 10), name: 7 }, now), null);
assert.deepEqual(T.mergeList([], "not a list", "t1", now).changed, []);

// Elements: ones without an id or a version are dropped, and fromPeer's filter is on this path too.
const els = T.cleanElements([
  { id: "a", version: 2, type: "rectangle" },
  { id: "btn", version: 1, type: "embeddable", link: "deck://term/rm" },
  { id: "l", version: 1, type: "rectangle", link: "deck://script/x" },
  { version: 1, type: "rectangle" },
  { id: "v", version: "1", type: "rectangle" },
]);
assert.deepEqual(els.map((e) => e.id), ["a", "l"]);
assert.equal(els[1].link, null, "a deck:// link on a shape is dropped");
assert.equal(T.cleanElements("x"), null);
// Pictures: images as data: URLs only.
assert.deepEqual(T.cleanFiles([
  { id: "p1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" },
  { id: "p2", mimeType: "text/html", dataURL: "data:text/html,<script>" },
  { id: "p3", mimeType: "image/png", dataURL: "https://evil.example/x.png" },
]).map((f) => f.id), ["p1"]);

console.log("canvas teamboards ok");
