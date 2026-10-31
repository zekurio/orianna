# AGENTS.md

## Dev shell

The dev shell comes from devenv, defined in `devenv.nix`, and direnv loads it
through `.envrc`. It provides bun, sqlite and ImageMagick, runs `bun install`
on entry, and sets `ORIANNA_CONFIG=./config.json`. Bun reads
`FLUXER_BOT_TOKEN` from `.env` on its own.

Outside direnv, prefix commands with `devenv shell`, for example
`devenv shell bun run typecheck`. The flake has no `devShells` output, so
`nix develop` won't work here.

There is no test suite, so run `bun run typecheck` before every commit.

## Code

The bot is written with [Effect](https://effect.website) v4; `node_modules/effect/CLAUDE.md`
points at its docs and examples.

- Talk to Fluxer through `request` in `src/fluxer.ts`, which turns a rejection
  into a `FluxerError`. fluxer.js already retries and waits out rate limits,
  so don't retry Fluxer calls on top.
- Fail with `UserError` (`refuse(...)`) for anything a member should read;
  the router replies with it. Other failures are logged.
- Platform-facing pieces are `Context.Service`s with a Fluxer layer next to
  them (`GuildAccess`, `PollTransport`, `RoleGuild`, `ExpressionGuild`);
  `src/main.ts` wires the layers together.
- Use `listen` from `src/fluxer.ts` for gateway events, so handlers run in
  fibers that stop on shutdown.
- bun:sqlite is synchronous, so drizzle queries run inline in effects.
- Read bot settings through the `Settings` service in
  `src/settings/settings.ts`, not `AppConfig`; they change while the bot
  runs. `AppConfig` holds only the deployment keys from the config file.
- The web interface is a React app in `src/web/app`. `src/web/server.ts`
  imports its `index.html`; run from source, Bun bundles the app on demand and
  reloads open pages, and `bun run build` bundles it into the executable.
- The app calls the bot with Effect RPC. Each call is defined once, with
  schemas, in `src/web/rpc.ts`; `src/web/handlers.ts` implements it, and the
  app reads it as an atom from `src/web/app/api.ts` with the hooks in
  `@effect/atom-react`. A failure a member should read is an error in the
  call's schema. Wrap anything else in `hide`, which logs it and tells the
  app only that something went wrong.

## Nix

`flake.nix` exports the package from `nix/package.nix` and the NixOS module
from `nix/module.nix`, for x86_64-linux and aarch64-linux.

- `nix build` builds the package. Run it after touching anything under `nix/`,
  `package.json` or `bun.lock`. The flake only sees files git knows about, so
  `git add` new files first.
- `node_modules` is a fixed-output derivation pinned to `bun.lock`. When the
  lockfile changes, set `outputHash` in `nix/package.nix` to `lib.fakeHash`,
  run `nix build`, copy the hash from the error, and commit it with the
  lockfile.
- The package runs `bun run build`, which compiles `src/main.ts` and what it
  imports into one executable, and embeds `drizzle/` with `--asset`. A file
  the bot reads at runtime has to be embedded the same way, added to the
  fileset in `nix/package.nix`, and found like the migrations in
  `src/db/index.ts`.
- `nix fmt -- flake.nix nix/*.nix` formats with nixfmt. Pass files, not
  directories; nixfmt has deprecated directory arguments.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sticker): accept tags with spaces

Body explaining what changed and why, wrapped at 72 columns.
```

- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `build`, `chore`.
- Scope is optional. Use the area you touched: `emoji`, `sticker`, `polls`,
  `commands`, `config`, `db`, `nix`.
- Subject in the imperative, lowercase, no trailing period, under 72
  characters.
- Unknown config keys stop the bot at startup, so renaming or removing a key
  breaks existing deployments. Mark those commits with `!` and a
  `BREAKING CHANGE:` footer that says what to change in the config.
- The bot settings in the database are validated on every start too, so
  renaming or removing a settings key also needs code that rewrites the
  stored document, or the bot won't start.
- Commit a schema change and its generated migration together. Never edit a
  migration that has already been committed.
- When `src/config.ts` changes, update `config.example.json` or
  `settings.example.json`, and `docs/configuration.md`, in the same commit.
- When a command, its options or a permission changes, update
  `docs/commands.md` or `docs/permissions.md` in the same commit.

## Branches

Branch from `main`. Name branches with three lowercase words joined by
hyphens, with no type prefix: `sticker-tag-limits`, not
`feat/sticker-tag-limits`.

## Pull requests

- The title follows the commit format.
- The body says what changed and why, and calls out new or renamed config keys,
  new migrations and `outputHash` bumps.
- Say how you checked the change. With no tests, that means
  `bun run typecheck`, `nix build` where it applies, and whether you ran the
  bot against an instance.
- One change per PR. Open it with `gh pr create`.
