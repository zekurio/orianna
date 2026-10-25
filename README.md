# Orianna

A bot for a self-hosted [Fluxer](https://fluxer.app) instance. Its first job is
emoji and sticker proposals: members propose one, the server votes on it, and
the bot adds it if the vote passes. Nobody but the bot needs permission to
create expressions.

Fluxer has no slash commands or buttons yet, so commands use a prefix and
votes are reactions. Commands are written against an adapter-neutral interface
(`src/commands/command.ts`), so slash commands can be added later without
rewriting them.

## Commands

| Command | Who | |
|---|---|---|
| `!emoji propose <name>` + image attachment or link | anyone (or `proposerRoleIds`) | Start a vote on a new emoji |
| `!sticker propose <name...> [--desc text] [--tags a, b]` + image attachment or link | anyone (or `proposerRoleIds`) | Start a vote on a new sticker |
| `!emoji list`, `!sticker list` | anyone | Show open proposals |
| `!emoji cancel <id>`, `!sticker cancel <id>` | proposer or admin | Withdraw a proposal |
| `!emoji approve <id> [reason]`, `!sticker approve ...` | admin | End the vote early and add it |
| `!emoji reject <id> [reason]`, `!sticker reject ...` | admin | End the vote early without adding it |
| `!help` | anyone | List commands; flip pages with ⬅️ / ➡️ |
| `!ping` | anyone | |

Options written as `--name value` can go in any order after the other
arguments, and their value runs until the next `--option`:

```
!sticker propose sad face --desc A very sad face --tags sad, cry
```

Instead of attaching the image, you can paste a direct `http(s)` link to it
anywhere before the `--options`, optionally wrapped in `<...>` to hide the
embed. The bot checks that the first bytes are an image before downloading the
rest, so links to web pages are refused:

```
!emoji propose party_cat <https://example.org/party-cat.gif>
```

Every poll gets a random name like `green-panther`, shown at the bottom of the
poll; `<id>` is that name. Names are never reused.

Admins are the guild owner, members with Manage Expressions, and anyone with a
role in `adminRoleIds`.

A proposal needs a yes vote from every member who could see the polls channel
when it was posted, not counting bots, and more yes than no. The poll pings
`@here`, and the number is fixed when the vote starts. The vote ends as soon as
it has enough yes votes, otherwise after `votingHours`. Each member
gets one vote; switching reactions moves the vote. The image is
stored when the proposal is made, so deleting the original message doesn't
matter. Images must be PNG, JPEG, GIF, WebP or AVIF.

Emoji names are 2–32 letters, digits or underscores. Sticker names are 2–30
characters, spaces allowed; descriptions are up to 500 characters, and up to 10
tags of up to 30 characters each.

The bot needs these permissions in the guild: view and send messages, attach
files, add reactions, manage messages (to remove a member's old vote reaction
and their page-turn reactions on `!help`),
mention @everyone and @here (to ping the polls channel) and create expressions.

## Configuration

Settings come from a JSON file (`ORIANNA_CONFIG`, default `./config.json`).
Unknown keys are an error. See [`config.example.json`](config.example.json).

| Key | Default | |
|---|---|---|
| `instance` | required | Instance origin; the bot reads `/.well-known/fluxer` from it |
| `guildId` | required | The guild to serve; everything else is ignored |
| `pollsChannelId` | required | Where polls are posted and voted on |
| `prefix` | `"!"` | |
| `database` | `"./data/orianna.db"` | SQLite file, created and migrated on startup |
| `adminRoleIds` | `[]` | Extra admin roles |
| `emoji.votingHours` | `48` | |
| `emoji.maxOpenPerUser` | `3` | |
| `emoji.maxImageBytes` | `524288` | Match your instance's `emoji_max_size` |
| `emoji.proposerRoleIds` | `[]` | Roles allowed to propose; empty means everyone |
| `sticker.*` | | Same keys as `emoji`; `maxImageBytes` should match `sticker_max_size` |

Leave out the `emoji` or `sticker` section to turn those proposals off.

The token is read from the systemd credential `token` if present, otherwise
from `ORIANNA_TOKEN`.

## Development

```sh
direnv allow            # or: devenv shell
cp config.example.json config.json
echo 'ORIANNA_TOKEN=...' > .env
bun run dev
```

`devenv test` runs the typechecker. After changing
`src/db/schema.ts`, run `bun run db:generate` and commit the new migration.

## Deployment on NixOS

```nix
{
  inputs.orianna.url = "git+ssh://git@github.com/zekurio/orianna";

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
              emoji = { };
              sticker = { };
            };
          };
        }
      ];
    };
  };
}
```

The service runs as a `DynamicUser` with its database in `/var/lib/orianna`.

When `bun.lock` changes, update `outputHash` in `nix/package.nix`: set it to `lib.fakeHash`, run
`nix build`, and copy the hash from the error.
