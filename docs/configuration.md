# Configuration

The bot reads a JSON file, `config.json` in the working directory unless
`ORIANNA_CONFIG` points somewhere else. [`config.example.json`](../config.example.json)
has every section filled in. On NixOS, the same keys go under
`services.orianna.settings`.

The bot refuses to start when the file has a key it doesn't know, a value of
the wrong type, or a permission rule it can't read. The error names each
problem with its path, like `/emoji/votingHours`.

Sections that are missing turn their feature off. An empty section, `{}`,
turns it on with the defaults below.

## Top level

| Key | Default | What it does |
|---|---|---|
| `instance` | Required | Origin of the Fluxer instance, like `https://chat.example.org`. The bot reads `/.well-known/fluxer` from it. |
| `guildId` | Required | The guild the bot serves. It ignores messages from anywhere else. |
| `pollsChannelId` | None | The channel where emoji and sticker proposals go up for a vote. Required when `emoji` or `sticker` is on. |
| `prefix` | `"!"` | What commands start with |
| `database` | `"./data/orianna.db"` | The SQLite file. A relative path starts from the working directory. The NixOS module sets `/var/lib/orianna/orianna.db`. |
| `permissions` | See below | Who may do what. [Permissions](permissions.md) covers it. |
| `emoji` | Off | Emoji proposals |
| `sticker` | Off | Sticker proposals |
| `polls` | Off | `!poll` |
| `roleMenus` | Off | Role menus |
| `boards` | Off | Starboards |

## `permissions`

| Key | Default | What it does |
|---|---|---|
| `everyone` | `["+emoji.propose", "+sticker.propose", "+polls.create"]` | Rules for every member |
| `roles` | `{}` | Rules per role, keyed by role ID |

## `emoji` and `sticker`

Both sections take the same keys.

| Key | Default | What it does |
|---|---|---|
| `votingHours` | `48` | How long a vote runs |
| `maxOpenPerUser` | `3` | How many open proposals of this kind one member can have |
| `maxImageBytes` | `524288` | Largest file the bot uploads. Set it to the instance's `emoji_max_size` or `sticker_max_size`, which are 512 KiB unless you changed them. The bot scales larger images down to fit. |
| `threshold` | `1` | Share of the members who can see the polls channel that have to vote ✅, more than 0 and at most 1. The bot rounds up, so `0.5` with 9 members asks for 5. `1` asks for all of them. A proposal also needs more ✅ than ❌. |

## `polls`

| Key | Default | What it does |
|---|---|---|
| `defaultHours` | `24` | How long a poll runs when it's given no duration. 672, four weeks, at most. |
| `maxOpenPerUser` | `5` | How many open polls one member can have |

## Role menus

A role menu is a message from the bot that lists roles, each with an emoji.
Members react to get a role and remove the reaction to drop it.

```json
"roleMenus": {
  "channelId": "000000000000000000",
  "menus": [
    {
      "name": "notifications",
      "title": "Notifications",
      "description": "Pick what you'd like to be pinged for.",
      "options": [
        { "emoji": "📣", "roleId": "100000000000000001", "description": "server news and downtime" },
        { "emoji": "🎉", "roleId": "100000000000000002", "description": "game nights and watch parties" }
      ]
    }
  ]
}
```

| Key | Default | What it does |
|---|---|---|
| `channelId` | Required | Where menus go, unless a menu names its own channel |
| `menus` | `[]` | The menus |

Each menu:

| Key | Default | What it does |
|---|---|---|
| `name` | Required | Lowercase letters, digits and hyphens, up to 32, starting with a letter or digit. The bot uses it to find the menu's message again after a restart. Renaming a menu deletes its message and posts a new one. |
| `title` | Required | Up to 256 characters |
| `description` | None | Up to 1000 characters, shown above the roles |
| `mode` | `"multi"` | `"multi"` lets members take any number of roles. With `"single"`, picking one role replaces the last. |
| `channelId` | `roleMenus.channelId` | Where this menu goes |
| `options` | Required | The roles, 1 to 30 of them |

Each option:

| Key | Default | What it does |
|---|---|---|
| `emoji` | Required | A Unicode emoji, `name:id` or `<:name:id>`. Use `<a:name:id>` for an animated one. Each emoji can appear once per menu. |
| `roleId` | Required | The role to hand out. A role can be in one menu only. |
| `description` | None | Up to 100 characters, shown after the role |

When it starts, the bot posts any menu that has no message yet and edits
the ones whose text changed. It leaves the rest alone. While the bot was
offline, members may have added or removed reactions, and the bot gives and
takes roles to match. Taking a menu or an option out of the config removes
its message or its reaction, and members keep the roles they have.

The bot leaves an option out of its menu, and logs why, when it can't safely
hand out the role:

- the role doesn't exist
- the bot lacks Manage Roles, or the role is as high as the bot's highest role
  or higher
- the role has a moderator permission, like Manage Messages, Kick Members or
  Mention Everyone. This keeps a mistyped role ID from handing out moderator
  roles.

The bot removes reactions with emojis that aren't in the menu. If someone
deletes a menu message, the bot posts it again the next time it starts. When
a member leaves the guild, the bot removes their reactions.

## Boards

A board is a channel where the bot reposts messages that got enough
reactions with one emoji, like a starboard. You can have as many as you like,
say 💎 for gems and 🪨 for a hall of shame:

```json
"boards": [
  { "name": "gems", "emoji": "💎", "channelId": "000000000000000000", "threshold": 5 },
  {
    "name": "coal",
    "emoji": "🪨",
    "channelId": "000000000000000000",
    "threshold": 8,
    "keep": true,
    "ignoredChannelIds": ["100000000000000020"]
  }
]
```

Each board:

| Key | Default | What it does |
|---|---|---|
| `name` | Required | Lowercase letters, digits and hyphens, up to 32, starting with a letter or digit. Members type it in `!board top`. Renaming a board starts its leaderboard over. |
| `emoji` | Required | A Unicode emoji, `name:id` or `<:name:id>` |
| `channelId` | Required | Where the bot posts |
| `threshold` | `5` | How many members other than the author have to react before a message goes up |
| `keep` | `false` | Leaves a post up when reactions drop below `threshold` again. Without it, the bot takes the post down and puts it back up if the message gets there again. |
| `ignoredChannelIds` | `[]` | Channels whose messages never go up on this board |

The bot posts from every channel it can read, private ones included, so put
channels whose messages shouldn't be seen elsewhere in `ignoredChannelIds`.
It leaves out messages from NSFW channels unless the board's channel is NSFW
too, and doesn't show images their uploader marked NSFW. Messages in board
channels never go up.

The bot needs View Channel and Read Message History where members react, and
Send Messages and Embed Links in the board channels. Fluxer doesn't tell the
bot about reactions from while it was offline. It counts them the next time
someone reacts to the message.

[Commands](commands.md#boards) explains how a message goes up and comes down.

## Environment

| Variable | What it does |
|---|---|
| `ORIANNA_CONFIG` | Path to the config file. `config.json` if unset. |
| `FLUXER_BOT_TOKEN` | The bot token. Bun reads it from `.env` on its own. |
| `CREDENTIALS_DIRECTORY` | Set by systemd. When it holds a file called `token`, the bot uses that instead of `FLUXER_BOT_TOKEN`. |

## Reloading

Send the bot SIGHUP, or run `systemctl reload orianna`, and it reads the file
again. It applies `prefix` and `permissions` right away. Every other key needs
a restart, and the bot logs which of the changed keys those are. When the new
file doesn't load, the bot logs why and keeps the config it has.

With the NixOS module, `nixos-rebuild switch` reloads the bot when only
`prefix` or `permissions` changed and restarts it for anything else.
