# Configuration

Orianna keeps two kinds of configuration apart:

- The [config file](#the-config-file) says how to reach Fluxer, where to
  keep the database, and whether to serve the web interface. The bot reads it
  once, when it starts.
- The [bot settings](#bot-settings) say what the bot does in the guild: the
  prefix, permissions and every feature. They live in the database, and
  changes apply while the bot runs.

## The config file

The bot reads a JSON file, `config.json` in the working directory unless
`ORIANNA_CONFIG` points somewhere else.
[`config.example.json`](../config.example.json) is a complete one. On NixOS,
the same keys go under `services.orianna.settings`.

| Key | Default | What it does |
|---|---|---|
| `instance` | Required | Origin of the Fluxer instance, like `https://chat.example.org`. The bot reads `/.well-known/fluxer` from it. |
| `guildId` | Required | The guild the bot serves. It ignores messages from anywhere else. |
| `database` | `"./data/orianna.db"` | The SQLite file, which holds the bot settings too. A relative path starts from the working directory. The NixOS module sets `/var/lib/orianna/orianna.db`. |
| `web` | Off | The [web interface](#the-web-interface) |

The bot refuses to start when the file has a key it doesn't know or a value
of the wrong type. The error names each problem with its path, like
`/guildId`.

The bot token doesn't go in the file; see [Environment](#environment).

### The web interface

The bot can serve a web interface, where members of the guild sign in with
their Fluxer account. It has pages for the boards, the commands and settings,
which are still empty. For now it handles signing in and out.

To turn it on:

1. Open the bot's application on your Fluxer instance and add
   `<publicUrl>/auth/callback` as a redirect URI, like
   `https://orianna.example.org/auth/callback`.
2. Hand the bot the application's client secret, in `FLUXER_CLIENT_SECRET` or
   as the `client-secret` systemd credential; see [Environment](#environment).
   On NixOS, set `services.orianna.clientSecretFile`.
3. Add the `web` section, and put a reverse proxy with TLS in front of `host`
   and `port`.

```json
"web": {
  "publicUrl": "https://orianna.example.org",
  "clientId": "000000000000000000"
}
```

| Key | Default | What it does |
|---|---|---|
| `publicUrl` | Required | Where people open the web interface, without a path |
| `clientId` | Required | The ID of the bot's application |
| `host` | `"127.0.0.1"` | The address the bot listens on |
| `port` | `8080` | The port the bot listens on |

Signing in asks Fluxer for the `identify` scope only, and the bot keeps just
the member's ID. Only members of the guild get in. A member stays signed in
for 30 days, and the guild owner and members with Administrator see the
server's settings too. When `publicUrl` starts with `https://`, the session
cookie is only sent over HTTPS.

## Bot settings

The bot settings are one JSON document in the database. The guild owner and
members with Administrator edit it in chat:

1. `!settings export` replies with the settings as `settings.json`.
2. Edit the file.
3. Send it back with `!settings import`, attached to the message.

The import replaces all settings at once, so a section you leave out goes
back to its default or turns its feature off. The bot checks the whole file
first. If anything is wrong, it changes nothing and replies with each
problem and its path, like `/boards/1/threshold`. Otherwise it replies with
the sections that changed, and they apply right away. `!settings log` shows
who changed what, and when. [Commands](commands.md#settings) has the details.

[`settings.example.json`](../settings.example.json) has every section filled
in.

Sections that are missing turn their feature off. An empty section, `{}`,
turns it on with the defaults below.

| Key | Default | What it does |
|---|---|---|
| `prefix` | `"!"` | What commands start with |
| `permissions` | See below | Who may do what. [Permissions](permissions.md) covers it. |
| `pollsChannelId` | None | The channel where emoji and sticker proposals go up for a vote. Required when `emoji` or `sticker` is on. |
| `emoji` | Off | Emoji proposals |
| `sticker` | Off | Sticker proposals |
| `polls` | Off | `!poll` |
| `roleMenus` | Off | Role menus |
| `boards` | Off | Starboards |

### `permissions`

| Key | Default | What it does |
|---|---|---|
| `everyone` | `["+emoji.propose", "+sticker.propose", "+polls.create"]` | Rules for every member |
| `roles` | `{}` | Rules per role, keyed by role ID |

### `emoji` and `sticker`

Both sections take the same keys.

| Key | Default | What it does |
|---|---|---|
| `votingHours` | `48` | How long a vote runs |
| `maxOpenPerUser` | `3` | How many open proposals of this kind one member can have |
| `maxImageBytes` | `524288` | Largest file the bot uploads. Set it to the instance's `emoji_max_size` or `sticker_max_size`, which are 512 KiB unless you changed them. The bot scales larger images down to fit. |
| `threshold` | `1` | Share of the members who can see the polls channel that have to vote ✅, more than 0 and at most 1. The bot rounds up, so `0.5` with 9 members asks for 5. `1` asks for all of them. A proposal also needs more ✅ than ❌. |

### `polls`

| Key | Default | What it does |
|---|---|---|
| `defaultHours` | `24` | How long a poll runs when it's given no duration. 672, four weeks, at most. |
| `maxOpenPerUser` | `5` | How many open polls one member can have |

### Role menus

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

When it starts, and whenever the settings change, the bot posts any menu
that has no message yet and edits the ones whose text changed. It leaves the
rest alone. While the bot was offline, members may have added or removed
reactions, and the bot gives and takes roles to match. Taking a menu or an
option out of the settings removes its message or its reaction, and members
keep the roles they have.

The bot leaves an option out of its menu, and logs why, when it can't safely
hand out the role:

- the role doesn't exist
- the bot lacks Manage Roles, or the role is as high as the bot's highest role
  or higher
- the role has a moderator permission, like Manage Messages, Kick Members or
  Mention Everyone. This keeps a mistyped role ID from handing out moderator
  roles.

The bot removes reactions with emojis that aren't in the menu. If someone
deletes a menu message, the bot posts it again the next time it starts or
the settings change. When
a member leaves the guild, the bot removes their reactions.

### Boards

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
| `FLUXER_CLIENT_SECRET` | The client secret of the bot's application, which the [web interface](#the-web-interface) needs. Bun reads it from `.env` too. |
| `CREDENTIALS_DIRECTORY` | Set by systemd. When it holds a file called `token`, the bot uses that instead of `FLUXER_BOT_TOKEN`, and a file called `client-secret` instead of `FLUXER_CLIENT_SECRET`. |

## Changes while the bot runs

A change to `prefix` or `permissions` applies to the next command. A change
to any other section starts the features over: the bot takes down what it
runs for emoji and sticker proposals, polls, role menus and boards, and
starts them again from the new settings. That takes a moment, and in that
moment:

- Work in flight stops, as it does when the bot shuts down. A role menu that
  was being brought up to date is brought up to date again right after.
  Commands that were already running finish.
- Reactions to role menus and boards are missed. Role menus catch up on them
  straight away, and boards count the reactions again on the next one.
- Votes on polls still count. A 🛑 on a poll is acted on once polls are
  back. A vote that would have ended a proposal early ends it with the next
  vote, or at its deadline.

Turning a feature off doesn't touch its open polls. They stay open past
their deadline, and close and get their result once the feature is back on.

## Reloading

There's nothing to reload. Bot settings apply as soon as they change, and
the config file only has what takes a restart. When the bot gets SIGHUP, it
logs that and carries on.

With the NixOS module, `nixos-rebuild switch` restarts the bot whenever its
config file changes.
