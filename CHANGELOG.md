# Changelog

## 1.5.1 (2026-11-12)

- A board shared with a team catches up every 2 minutes, so a change missed while a connection
  dropped arrives without reopening it.

## 1.5.0 (2026-10-31)

- Boards are shared with a Deck team for good: Share > Share with <team> (also on a board's tab), and
  the board shows in every member's Canvas, kept in step whenever members are online together,
  with each other's cursors while it is open on two Decks, and an avatar at the top right for each
  of the others with their round trip in ms under it. No invite and no host.
- Share's live invite is gone, with its knock, view-only roles and end-of-sharing choices: sharing
  is with a team only, and a shared board stays shared. Only whoever shared a board, or the
  team's owner, can stop sharing it or delete it for everyone. Needs Deck 1.14.0.
- Excalidraw's translations other than English are left out by a setting in package.json rather
  than a deck-plugin.config.mjs, so the registry can rebuild and type-check it. Nothing changes in
  the plugin itself.

## 1.4.2 (2026-10-30)

- A licence, this changelog, a README rewritten with a screenshot, and the permissions it uses
  declared. Built from its own lockfile.

## 1.4.1 (2026-10-20)

- A board in a floating window draws and takes keys

## 1.4.0 (2026-10-18)

- The first version in Deck's plugin registry.
