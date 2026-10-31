# Orianna

Orianna is a bot for one guild on a self-hosted [Fluxer](https://fluxer.app)
instance.

- Members propose emojis and stickers, the server votes on them with
  reactions, and the bot adds the ones that pass. An image can be attached,
  linked, or taken from a 7TV emote. Wide images are cut into a row of emojis.
- Members start their own polls with `!poll` and watch the results come in.
- Role menus let members give themselves roles by reacting to a message.
- Boards repost messages that got enough reactions, like a starboard, or a
  hall of shame.
- Permission rules decide who may do what.
- Settings live in the bot's database. The server's admins change them in chat
  while the bot runs, and every change is recorded.
- Members sign in to a web interface with their Fluxer account. Its pages are
  still empty.

Fluxer has no slash commands or buttons yet, so commands start with a prefix,
`!` by default, and every vote is a reaction.

## Docs

- [Commands](docs/commands.md) covers every command and how votes work.
- [Permissions](docs/permissions.md) explains the rules that decide who may
  do what.
- [Configuration](docs/configuration.md) covers the config file and every bot
  setting.

## Running it

You need a bot token from your Fluxer instance and the ID of your guild. The
config file only says how to reach Fluxer and where to keep the database.
Everything else is a bot setting, which starts at the defaults. Once the bot
is running, the guild owner or a member with Administrator turns features on
with `!settings export` and `!settings import`, as
[Configuration](docs/configuration.md#bot-settings) describes.

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
            };
          };
        }
      ];
    };
  };
}
```

The module writes `settings` to `/etc/orianna/config.json`, keeps the database
in `/var/lib/orianna`, and hands the token to the service as a systemd
credential, so the file can stay readable by root only. For the web
interface, add `web` to `settings` and point `clientSecretFile` at the
application's client secret, which the service gets the same way.
[Configuration](docs/configuration.md#the-web-interface) has the steps. After a
`nixos-rebuild switch`, the bot restarts when the config file changed.

### Anywhere else

Build the bot with [Bun](https://bun.sh):

```sh
bun install --production
bun run build
```

That writes `dist/orianna`, one executable with the bot, the web interface
and the Bun runtime inside. It runs on the kind of machine that built it,
which needs nothing else but ImageMagick 7. Then, where it runs:

```sh
cp config.example.json config.json
echo 'FLUXER_BOT_TOKEN=...' > .env
./dist/orianna
```

Fill in the instance and guild ID in `config.json` first. Fill in `web` and
add `FLUXER_CLIENT_SECRET` to `.env` for the web interface, or remove `web`
to run without it. The bot reads the config from `ORIANNA_CONFIG`, or from
`./config.json` when that's unset, and loads `.env` from the working
directory. It creates the database and applies migrations when it starts.
[`settings.example.json`](settings.example.json) shows every bot setting,
ready to edit and send to `!settings import`.

### What the bot needs in Fluxer

Give the bot's role these permissions. Skip the rows for features you leave
off.

| Feature | Where | Permissions |
|---|---|---|
| Commands | Where members run them | View Channel, Send Messages, Embed Links, Add Reactions, Manage Messages |
| `!settings` | Where admins run it | Attach Files, for `!settings export` |
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

For the web interface on your machine, set `web.publicUrl` to
`http://localhost:8080`, add `http://localhost:8080/auth/callback` as a
redirect URI of the application, and put `FLUXER_CLIENT_SECRET` in `.env`.

| Command | What it does |
|---|---|
| `bun run dev` | Runs the bot and restarts it when a file changes. Changes to the web interface's app in `src/web/app` reload open pages instead. |
| `bun run build` | Compiles the bot into `dist/orianna`, the executable the Nix package ships |
| `bun run typecheck` | Runs `tsc --noEmit` |
| `bun run db:generate` | Writes a migration for changes to `src/db/schema.ts` |

After changing `src/db/schema.ts`, run `bun run db:generate` and commit what
it writes to `drizzle/`. [AGENTS.md](AGENTS.md) has the rest: commit style,
branch names, and what to run before a pull request.
