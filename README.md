# Orianna

A bot for a self-hosted [Fluxer](https://fluxer.app) instance. Its first job is
emoji proposals: members propose an emoji, the server votes on it, and the bot
adds it if the vote passes. Nobody but the bot needs permission to create
emojis.

Fluxer has no slash commands or buttons yet, so commands use a prefix and
votes are reactions. Commands are written against an adapter-neutral interface
(`src/commands/command.ts`), so slash commands can be added later without
rewriting them.

## Commands

| Command | Who | |
|---|---|---|
| `!emoji propose <name>` + image attachment | anyone (or `proposerRoleIds`) | Start a vote on a new emoji |
| `!emoji list` | anyone | Show open proposals |
| `!emoji cancel <id>` | proposer or admin | Withdraw a proposal |
| `!emoji approve <id> [reason]` | admin | End the vote early and add the emoji |
| `!emoji reject <id> [reason]` | admin | End the vote early without adding it |
| `!help`, `!ping` | anyone | |

Admins are the guild owner, members with Manage Expressions, and anyone with a
role in `adminRoleIds`.

A proposal passes when it has at least `minYesVotes` yes votes and more yes than
no. Each member gets one vote; switching reactions moves the vote. The image is
stored when the proposal is made, so deleting the original message doesn't
matter. Names are 2–32 letters, digits or underscores, and images must be PNG,
JPEG, GIF, WebP or AVIF.

The bot needs these permissions in the guild: view and send messages, attach
files, add reactions, manage messages (to remove a member's old vote reaction)
and create expressions.

## Configuration

Settings come from a JSON file (`ORIANNA_CONFIG`, default `./config.json`).
Unknown keys are an error. See [`config.example.json`](config.example.json).

| Key | Default | |
|---|---|---|
| `instance` | required | Instance origin; the bot reads `/.well-known/fluxer` from it |
| `guildId` | required | The guild to serve; everything else is ignored |
| `prefix` | `"!"` | |
| `database` | `"./data/orianna.db"` | SQLite file, created and migrated on startup |
| `adminRoleIds` | `[]` | Extra admin roles |
| `emoji.channelId` | required | Where proposals are posted |
| `emoji.votingHours` | `48` | |
| `emoji.minYesVotes` | `3` | |
| `emoji.maxOpenPerUser` | `3` | |
| `emoji.maxImageBytes` | `524288` | Match your instance's `emoji_max_size` |
| `emoji.proposerRoleIds` | `[]` | Roles allowed to propose; empty means everyone |

Leave out the `emoji` section to turn proposals off.

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
              emoji.channelId = "3456789012";
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
