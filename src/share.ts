// A live connection between two or more Decks drawing on one board, with no server of ours.
//
// The machines talk directly over WebRTC. To find each other they first swap a short handshake,
// which travels through public Nostr relays (Trystero's nostr strategy): the relays see only a
// hash of the room and the handshake encrypted with the share code, never the board. After that
// the board goes peer to peer, encrypted by WebRTC itself.
//
// The share code names the room, and the code together with a password the host chose is the key
// the handshake is encrypted with. So joining takes both: a code passed on in a chat is not enough
// without the password, which can be said out loud. A wrong password does not fail loudly, since
// the other side simply cannot read the handshake; the guest stays at "connecting".
//
// Pictures travel as their own messages, one per picture, under a size cap (see sync.ts).
//
// Not yet handled: networks where a direct connection is impossible (that needs a relay, a TURN
// server); a guest stuck there sees "couldn't reach the board" after a while.
import { joinRoom, type JsonValue } from "@trystero-p2p/nostr";
/** This Deck's id in a room, the one the others know it by. */
export { selfId } from "@trystero-p2p/nostr";

/** What travels between Decks on a shared board. */
export type ShareMsg =
  /** The whole board, from the host to a Deck that just joined. */
  | { t: "scene"; elements: JsonValue[] }
  /** Elements edited since the last message. */
  | { t: "update"; elements: JsonValue[] }
  /** Who this Deck is, sent to each peer as it arrives: the name on its cursor and in the bar,
   *  whether it is the host (whose leaving ends the share for everyone else), and the share
   *  version it speaks. The host sends the board only once a joiner's hello shows it can read it. */
  | { t: "hello"; name: string; host: boolean; v?: number }
  /** Pictures that image elements show, as Excalidraw keeps them (id, mimeType, dataURL, created). */
  | { t: "files"; files: JsonValue[] }
  /** The host stopped sharing. Sent before it leaves, so the others end at once rather than
   *  waiting for the connection to time out. */
  | { t: "end" }
  /** Who may draw, from the host: to each joiner, and to everyone when it changes (see sync.ts). */
  | { t: "roles"; def: "edit" | "view"; per: Record<string, "edit" | "view"> }
  /** The host removed someone. Sent to everyone: the one named leaves, and the rest stop
   *  listening to it. A Deck that ignores this could stay, so to keep someone out for good the
   *  host shares again with a new code and password. */
  | { t: "kick"; peer: string }
  /** Where someone's pointer is, for the cursor drawn on everyone else's board. With the laser
   *  tool, Excalidraw draws the trail on the others' boards while the button is down. */
  | { t: "pointer"; x: number; y: number; button: "up" | "down"; tool: "pointer" | "laser" };

export interface Session {
  /** Send to everyone, or to one peer. Settles once the message is handed to the connection
   *  (Trystero waits while the connection's buffer is full), so awaiting it paces the sender. */
  send(msg: ShareMsg, to?: string): Promise<void>;
  peers(): string[];
  /** Round trip to a peer in milliseconds, over the connection itself. */
  ping(peer: string): Promise<number>;
  /** Leave the room; with `announce`, tell everyone the share is over first. Safe to call twice. */
  close(announce?: boolean): Promise<void>;
}

/** Shared by every Deck, so two Decks with the same code meet in the same room. */
const APP_ID = "deck-canvas-share";

export function connect(code: string, password: string, on: {
  message: (msg: ShareMsg, peer: string) => void;
  join: (peer: string) => void;
  leave: (peer: string) => void;
}): Session {
  const room = joinRoom({ appId: APP_ID, password: `${code}:${password}` }, code);
  // Action names are capped at 12 bytes by Trystero; one action carries every message type.
  const action = room.makeAction<ShareMsg>("board", { onMessage: (msg, ctx) => on.message(msg, ctx.peerId) });
  room.onPeerJoin = on.join;
  room.onPeerLeave = on.leave;
  let closed = false;
  return {
    send: (msg, to) => action.send(msg, to ? { target: to } : undefined).catch(() => {}),
    peers: () => Object.keys(room.getPeers()),
    ping: (peer) => room.ping(peer),
    close: async (announce) => {
      if (closed) return;
      closed = true;
      // Leaving tears the connections down, so the goodbye has to be on its way first. A peer
      // that never gets it still notices the host gone when the connection drops.
      // send() settles once the message is queued, not delivered, so it also gets a moment on the
      // wire: leaving straight after made guests see the connection drop before the goodbye.
      if (announce) {
        await Promise.race([action.send({ t: "end" }).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        await new Promise((r) => setTimeout(r, 400));
      }
      await room.leave();
    },
  };
}
