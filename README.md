# Canvas for Deck

Excalidraw boards for each project, in a pane: sketch, diagram, paste screenshots and links, and
draw on a board live with other Decks. Open it from the **+** beside your tabs, or a pane's menu,
and choose **Canvas**.

![Canvas](docs/screenshot.png)

## Boards

Each workspace folder has its own boards, shown as tabs:

- **+** after the last tab makes a board; double-click a tab to rename it; the X deletes it.
- Right-click a tab to rename, duplicate or delete it.
- Drag a tab to reorder.
- The buttons at the top right show a grid and snap to it (hold Ctrl to move freely), for every
  board.

Boards save as you draw, in Deck's config on this machine: a `canvas-<project>` file per board,
with its pasted pictures in a `-files` file beside it, and the grid choice in `canvas-grid`. They
do not sync.

## Drawing together

Boards are shared with a Deck team (start or join one in Deck's Settings > Teams first), and once
shared they stay shared: there is no invite to send and no host to wait for.

- **Share** (bottom of a board), or right-click its tab: **Always share with** *team*. The board
  moves out of the project and shows, with a team icon, in every project's boards on every
  member's Deck.
- Each member keeps a copy. Whenever two of you are online together the copies are brought in
  step, shape by shape, so what was drawn while you were apart arrives when you meet.
- A board open on two Decks follows along as it is drawn, with each other's cursors and names. The
  bottom of the board says whose it is and who else has it open.
- Rename it and the others see the new name. **Delete** removes it for everyone; **Stop sharing
  with the team** keeps a copy in this project and removes it for the others.
- Buttons that run something on this machine, and embedded web pages, are never shared, and none
  arrive from anyone else. Pictures up to 4 MB each are.

There is no server of yours involved: the Decks connect directly, and find each other through
public Nostr relays that only ever see an encrypted handshake. Networks where two machines cannot
connect directly (some offices and mobile networks) are not handled yet.

Canvas was Deck's built-in Pinboard until 1.1. Deck renames old boards to Canvas's files the
first time it starts, so a board you made there is the first tab here.
