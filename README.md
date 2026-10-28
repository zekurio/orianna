# Orianna

A bot for a self-hosted [Fluxer](https://fluxer.app) instance. Members propose
an emoji or sticker, the server votes on it with reactions, and the bot adds it
if the vote passes. The image can be attached, linked, or taken from a 7TV
emote, and images at least twice as wide as they are tall (or the other way
round) are cut into pieces. Members with Manage Expressions can skip the vote
with `!emoji add` and `!sticker add`. Members can also start their own polls
with `!poll`, with live results and an announcement when they end. Role menus
let members pick roles, like announcement pings, by reacting to a message the
bot keeps in sync with the config. Permission rules in the config decide which
roles may do what, and `!perms` shows what a member may do and which rule
decided it.

Config keys are documented in [`src/config.ts`](src/config.ts) and NixOS module
options in [`nix/module.nix`](nix/module.nix).

## Development

```sh
cp config.example.json config.json
echo 'FLUXER_BOT_TOKEN=...' > .env
bun install
bun run dev
```

| Command | |
|---|---|
| `bun run dev` | Run the bot and restart it when files change |
| `bun run start` | Run the bot |
| `bun run typecheck` | Run `tsc --noEmit` |
| `bun run db:generate` | Generate a migration from `src/db/schema.ts` |

The bot processes images with ImageMagick's `magick`, which the dev shell and
the Nix package provide. Anywhere else, install ImageMagick 7.

The bot applies pending migrations on startup. After changing
`src/db/schema.ts`, run `bun run db:generate` and commit what it writes to
`drizzle/`.
