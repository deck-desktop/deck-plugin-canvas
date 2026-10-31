// Sharing a board with a Deck team: Deck does the inviting (teamChannel.share sends an invite only to
// whom it is for, and lets in whoever joins with it), this file turns a teammate's invite into a
// notification with Join, and hands LiveShare the team share to host or to join. Started at plugin
// load, so an invite reaches a Deck whose Canvas tab is closed; stopped by the plugin's dispose.
import { teamChannel, subscribeTeams, teamsView, type Json, type P2pShare, type ShareHandlers, type TeamChannel, type TeamShareOptions } from "../shim/p2p.js";
import { notify, dismissNotification } from "../shim/ui.js";

const chans = new Map<string, TeamChannel<Json>>();
let unTeams: (() => void) | null = null;
let stopped = false;

/** An invite joined from its notification, waiting for Canvas to take it (now, or as it mounts). */
export interface Invite { team: string; id: string; board: string }
let pending: Invite | null = null;
export const takeJoin = (): Invite | null => { const p = pending; pending = null; return p; };

function channels() {
  if (stopped) return;
  const want = new Set(teamsView().map((t) => t.id));
  for (const [team, ch] of chans) if (!want.has(team)) { ch.close(); chans.delete(team); }
  for (const team of want) {
    if (chans.has(team)) continue;
    chans.set(team, teamChannel<Json>(team, "canvas", {
      message: () => {},
      invited: (inv) => {
        const board = String((inv.meta as { board?: string } | undefined)?.board ?? "a board");
        notify({
          kind: "attention", source: "Canvas", key: `team-invite:${inv.id}`,
          title: `${inv.from.name} invites you to ${board}`,
          body: "Join to draw on it together.",
          actions: [
            { label: "Join", primary: true, run: () => join({ team, id: inv.id, board }) },
            { label: "Not now", run: () => {} },
          ],
        });
      },
      uninvited: (id) => dismissNotification("Canvas", `team-invite:${id}`),
    }));
  }
}

function join(inv: Invite) {
  pending = inv;
  // An open Canvas takes it at once; otherwise Canvas opens and takes it as it mounts.
  window.dispatchEvent(new CustomEvent("canvas-team-join"));
  window.dispatchEvent(new CustomEvent("deck-open-view", { detail: "canvas" }));
}

const chan = (team: string) => chans.get(team) ?? teamChannel<Json>(team, "canvas", { message: () => {} });
/** Host a board for a team, or one member of it (`to`). */
export const hostShare = <S extends Json>(team: string, opts: TeamShareOptions, on: ShareHandlers<S>, to?: string): P2pShare<S> =>
  chan(team).share(opts, on, to);
/** Join a board a teammate invited this Deck to. */
export const joinShare = <S extends Json>(team: string, id: string, opts: Omit<TeamShareOptions, "id" | "meta" | "mode">, on: ShareHandlers<S>): P2pShare<S> =>
  chan(team).join(id, opts, on);

export function startTeamInvites() {
  stopped = false;
  unTeams = subscribeTeams(() => channels());
  channels();
}
export function stopTeamInvites() {
  stopped = true;
  unTeams?.();
  unTeams = null;
  for (const ch of chans.values()) ch.close();
  chans.clear();
}
