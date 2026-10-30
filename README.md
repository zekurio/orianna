# Orianna

Orianna is a bot for one guild on a self-hosted [Fluxer](https://fluxer.app)
instance.

- Members propose emojis and stickers, the server votes on them with
  reactions, and the bot adds the ones that pass. An image can be attached,
  linked, or taken from a 7TV emote. Wide images are cut into a row of emojis.
- Members start their own polls with `!poll` and watch the results come in.
- Role menus let members give themselves roles by reacting to a message.
- Permission rules in the config decide who may do what.

Fluxer has no slash commands or buttons yet, so commands start with a prefix,
`!` by default, and every vote is a reaction.

## Docs

- [Commands](docs/commands.md) covers every command and how votes work.
- [Permissions](docs/permissions.md) explains the rules that decide who may
  do what.
- [Configuration](docs/configuration.md) lists every config key, and the ones
  that apply without a restart.

## Running it

You need a bot token from your Fluxer instance and the IDs of your guild and
of the channel where proposals should go up for a vote.

### On NixOS

The flake exports a NixOS module:

```nix
{
  inputs.orianna.url = "github:zekurio/orianna";

  outputs = { nixpkgs, orianna, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        orianna.nixosModules.default
        {
          services.orianna = {
            enable = true;
            tokenFile = "/run/secrets/orianna-token";
            settings = {
              instance = "https://chat.example.org";
              guildId = "1234567890";
              pollsChannelId = "3456789012";
              permissions.roles."2345678901" = [ "+*" ];
              emoji = { };
              sticker = { };
              polls = { };
            };
          };
        }
      ];
    };
  };
}
```

An empty section like `emoji = { }` turns the feature on with its defaults.
The module writes `settings` to `/etc/orianna/config.json`, keeps the database
in `/var/lib/orianna`, and hands the token to the service as a systemd
credential, so the file can stay readable by root only.

After a `nixos-rebuild switch`, the bot reloads when only `prefix` or
`permissions` changed, and restarts for anything else.

### Anywhere else

Install [Bun](https://bun.sh) and ImageMagick 7, then:

```sh
bun install --production
cp config.example.json config.json
echo 'FLUXER_BOT_TOKEN=...' > .env
bun run start
```

Fill in the IDs in `config.json` first. The bot reads the config from
`ORIANNA_CONFIG`, or from `./config.json` when that's unset. Bun loads `.env`
on its own. The bot creates the database and applies migrations when it
starts.

Send the bot SIGHUP to apply changes to `prefix` and `permissions` without a
restart.

### What the bot needs in Fluxer

Give the bot's role these permissions. Skip the rows for features you leave
off.

| Feature | Where | Permissions |
|---|---|---|
| Commands | Where members run them | View Channel, Send Messages, Embed Links, Add Reactions, Manage Messages |
| Proposals | The guild | Manage Expressions |
| Proposals | The `pollsChannelId` channel | Send Messages, Attach Files, Add Reactions, Manage Messages, Read Message History, Mention Everyone |
| `!poll` | Where members run it | Send Messages, Embed Links, Add Reactions, Manage Messages, Read Message History |
| Role menus | The guild | Manage Roles, with the bot's highest role above every menu role |
| Role menus | The menu channels | Send Messages, Embed Links, Add Reactions, Manage Messages, Read Message History |

The bot uses Manage Messages to move a member's vote when they react with a
different answer, to remove reactions that don't belong, and to delete the
`!poll` message once the poll is up. In command channels, Add Reactions and
Manage Messages are only for the ⬅️ and ➡️ arrows that page through long
lists. Mention Everyone is for the `@here` on each proposal. Manage
Expressions lets the bot add emojis and stickers, and delete the pieces of a
cut image again if only some of them went in.

## Development

The dev shell comes from [devenv](https://devenv.sh) and loads through direnv.
It provides Bun, SQLite and ImageMagick, and points `ORIANNA_CONFIG` at
`./config.json`.

```sh
cp config.example.json config.json
echo 'FLUXER_BOT_TOKEN=...' > .env
bun run dev
```

| Command | What it does |
|---|---|
| `bun run dev` | Runs the bot and restarts it when a file changes |
| `bun run start` | Runs the bot |
| `bun run typecheck` | Runs `tsc --noEmit` |
| `bun run db:generate` | Writes a migration for changes to `src/db/schema.ts` |

After changing `src/db/schema.ts`, run `bun run db:generate` and commit what
it writes to `drizzle/`. [AGENTS.md](AGENTS.md) has the rest: commit style,
branch names, and what to run before a pull request.
