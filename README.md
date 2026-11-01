# Orianna

Orianna is a bot for servers on a self-hosted [Fluxer](https://fluxer.app)
instance. Invite it to as many servers as you like. Each one gets its own
settings, which start at the defaults.

- Members propose emojis and stickers, the server votes with reactions, and
  the bot adds what passes. The image can be an attachment, a link or a 7TV
  emote, and a wide image turns into a row of emojis.
- `!poll` starts a poll that shows its results while people vote.
- Role menus give a role to whoever reacts to a message.
- The starboard, copied from shinpuru, reposts messages once they get enough
  ⭐ reactions.
- Members give each other karma by reacting to messages, as on shinpuru, and
  getting into the starboard adds to it. Rules can hand out roles at a value.
- Permission rules decide who may run which command.
- Members sign in to a web interface with their Fluxer account. They can browse
  the starboard and the karma scoreboard and see the commands they're allowed
  to run, and admins change the settings there.

Fluxer has no slash commands or buttons yet, so commands start with a prefix,
`!` by default, and every vote is a reaction.

The code is the documentation. [`src/config.ts`](src/config.ts) describes
every key of the config file and every bot setting, the permission rules
included. `!help` and the web interface's commands page list the commands a
member may run, with their options.

## Running it

The config file says how to reach Fluxer, where the database goes, and where
to serve the web interface. Everything else is a per-server setting. A
server's owner and members with Administrator change those on the web
interface's Admin tab, or with `!settings export` and `!settings import` in
chat.

The web interface signs people in through the bot's application. Add
`<publicUrl>/auth/callback` to the application's redirect URIs and give the
bot its client secret.

### On NixOS

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
            settings.instance = "https://chat.example.org";
          };
        }
      ];
    };
  };
}
```

The module writes `settings` to `/etc/orianna/config.json` and keeps the
database in `/var/lib/orianna`. It hands the token to the service as a systemd
credential, so the file can stay readable by root only. For the web
interface, add `web` to `settings` and set `clientSecretFile`.

### Anywhere else

```sh
bun install --production
bun run build
```

That gives you `dist/orianna`, one executable with the web interface and the
Bun runtime inside. It runs on the same kind of machine that built it and
needs ImageMagick 7 next to it. To start it:

```sh
cp config.example.json config.json   # fill in the instance, and `web` or remove it
echo 'FLUXER_BOT_TOKEN=...' > .env    # and FLUXER_CLIENT_SECRET for the web interface
./dist/orianna
```

The bot reads the config from `ORIANNA_CONFIG`, or `./config.json`, and
creates its database on the first start.

### What the bot needs in Fluxer

Give the bot's role these permissions. Skip the rows for features a server
leaves off.

| Feature | Where | Permissions |
|---|---|---|
| Commands | Where members run them | View Channel, Send Messages, Embed Links, Add Reactions, Manage Messages |
| `!settings export` | Where admins run it | Attach Files |
| Proposals | The server | Manage Expressions |
| Proposals | The polls channel | Send Messages, Attach Files, Add Reactions, Manage Messages, Read Message History, Mention Everyone |
| `!poll` | Where members run it | Send Messages, Embed Links, Add Reactions, Manage Messages, Read Message History |
| Role menus | The server | Manage Roles, with the bot's highest role above every menu role |
| Role menus | The menu channels | Send Messages, Embed Links, Add Reactions, Manage Messages, Read Message History |
| Starboard | Where members react | View Channel, Read Message History |
| Starboard | The starboard channel | Send Messages, Embed Links, Attach Files |
| Karma | Where members react | View Channel, Read Message History |
| Karma rules | The server | Manage Roles, with the bot's highest role above every rule role; Kick Members and Ban Members for those rules |

Manage Messages lets the bot move a vote when someone picks another answer,
clear reactions that don't belong, and delete the `!poll` message once the
poll is up. In command channels it's only for the ⬅️ and ➡️ arrows on long
lists. Mention Everyone is for the `@here` on each proposal.

## Development

The dev shell comes from [devenv](https://devenv.sh) through direnv, with Bun,
SQLite and ImageMagick.

```sh
cp config.example.json config.json
echo 'FLUXER_BOT_TOKEN=...' > .env
bun run dev
```

`bun run dev` restarts the bot when a file changes and reloads open pages of
the web interface. `bun run typecheck` is the only check there is, so run it
before every commit.

The bot creates its database when it's missing and applies the migration in
`drizzle/` whenever it starts. The `db:*` scripts run drizzle-kit on the
database named in the config file, the same one the bot opens:

| Script | What it does |
|---|---|
| `bun db:generate` | Replaces `drizzle/` with a fresh `0000_init` from `src/db/schema.ts` |
| `bun db:push` | Changes the database to match `src/db/schema.ts`, without a migration |
| `bun db:studio` | Opens it in Drizzle Studio |

There are no migrations while the bot is in early development, so after
changing `src/db/schema.ts`, run `bun db:generate`, delete the database and
its `-wal` and `-shm` files, and start the bot, which creates it again.
[AGENTS.md](AGENTS.md) covers commit style, branch names and pull requests.
