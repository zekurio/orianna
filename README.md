# Orianna

A bot for a self-hosted [Fluxer](https://fluxer.app) instance. Members propose
an emoji or sticker, the server votes on it with reactions, and the bot adds it
if the vote passes. Role menus let members pick roles, like announcement pings,
by reacting to a message the bot keeps in sync with the config.

Config keys are documented in [`src/config.ts`](src/config.ts) and NixOS module
options in [`nix/module.nix`](nix/module.nix).

## Development

```sh
cp config.example.json config.json
echo 'ORIANNA_TOKEN=...' > .env
bun install
bun run dev
```

| Command | |
|---|---|
| `bun run dev` | Run the bot and restart it when files change |
| `bun run start` | Run the bot |
| `bun run typecheck` | Run `tsc --noEmit` |
| `bun run db:generate` | Generate a migration from `src/db/schema.ts` |

The bot applies pending migrations on startup. After changing
`src/db/schema.ts`, run `bun run db:generate` and commit what it writes to
`drizzle/`.
