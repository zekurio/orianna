# AGENTS.md

## Dev shell

The dev shell comes from devenv (`devenv.nix`), and direnv loads it through
`.envrc`. It provides bun and sqlite, runs `bun install` on entry, and sets
`ORIANNA_CONFIG=./config.json`. Bun reads `FLUXER_BOT_TOKEN` from `.env` on its
own.

Outside direnv, prefix commands with `devenv shell`, for example
`devenv shell bun run typecheck`. The flake has no `devShells` output, so
`nix develop` won't work here.

`devenv test` runs the typechecker. There is no test suite, so run it before
every commit.

## Nix

`flake.nix` exports the package (`nix/package.nix`) and the NixOS module
(`nix/module.nix`) for x86_64-linux and aarch64-linux.

- `nix build` builds the package. Run it after touching anything under `nix/`,
  `package.json` or `bun.lock`.
- `node_modules` is a fixed-output derivation pinned to `bun.lock`. When the
  lockfile changes, set `outputHash` in `nix/package.nix` to `lib.fakeHash`,
  run `nix build`, copy the hash from the error, and commit it with the
  lockfile.
- The package copies only `package.json`, `src/` and `drizzle/`. A new
  top-level file the bot needs at runtime has to be added to the fileset in
  `nix/package.nix`.
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
- Commit a schema change and its generated migration together. Never edit a
  migration that has already been committed.
- When `src/config.ts` changes, update `config.example.json` in the same
  commit.

## Branches

Branch from `main`. Name branches with three lowercase words joined by
hyphens, with no type prefix: `sticker-tag-limits`, not
`feat/sticker-tag-limits`.

## Pull requests

- The title follows the commit format.
- The body says what changed and why, and calls out new or renamed config keys,
  new migrations and `outputHash` bumps.
- Say how you checked the change. With no tests, that means `devenv test`,
  `nix build` where it applies, and whether you ran the bot against an
  instance.
- One change per PR. Open it with `gh pr create`.
