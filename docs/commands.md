# Commands

Commands start with the prefix, `!` by default. `!help` lists the commands you
may run. A group name on its own, like `!emoji`, lists its subcommands.

In the usage lines below, `<angle brackets>` mark what a command needs and
`[square brackets]` mark what you can leave out. Some commands need a
permission. [Permissions](permissions.md) says how to hand those out.

## General

| Command | Permission | What it does |
|---|---|---|
| `!help` | | Lists the commands you may run. ⬅️ and ➡️ turn the pages. |
| `!ping` | | Checks that the bot is alive and shows the round trip. |
| `!perms [member]` | | Shows what you or another member may do, and which rule decided each permission. Takes a mention or a user ID. |

## Emojis and stickers

`!emoji` and `!sticker` take the same subcommands. The examples use `!emoji`.

| Command | Permission | What it does |
|---|---|---|
| `!emoji propose [name] <image>` | `emoji.propose` | Puts an emoji up for a vote |
| `!emoji add [name] <image>` | `emoji.add` | Adds an emoji right away, without a vote |
| `!emoji list` | | Lists open proposals |
| `!emoji approve <poll> [reason]` | `emoji.decide` | Ends the vote and adds the emoji |
| `!emoji reject <poll> [reason]` | `emoji.decide` | Ends the vote without adding it |
| `!emoji cancel <poll>` | Your own, or `emoji.cancel-any` | Withdraws a proposal |

`<poll>` is the two-word name the bot gives each vote, like `green-panther`.
It's on the poll message and in `!emoji list`. A reason, if you give one,
shows in the result.

### The image

Attach the image, paste a link to it, or paste a link to a 7TV emote:

```
!emoji propose sadcat https://example.org/sadcat.png
!emoji propose https://7tv.app/emotes/01GCMQJGB0000D8ZK13J8KVCDX
!emoji propose dance https://cdn.7tv.app/emote/01GCMQJGB0000D8ZK13J8KVCDX/4x.webp
```

Links have to point at the public internet. The bot refuses a link to
`localhost`, a private network or another reserved address, and checks every
redirect the same way. The reply only says it couldn't download the image.
Attached files always work, wherever the instance keeps them. Links to the
instance's media host work too, even when it's on a private network.

The bot takes PNG, JPEG, GIF, WebP and AVIF. It stops downloading at 8 MiB,
or at `maxImageBytes` if you set that higher. An image larger than
`maxImageBytes` is scaled down until it fits, and the bot tells you when it
can't get it small enough. When the bot has to touch an
image at all, the result is at most 128 pixels on its longest side for an
emoji and 320 for a sticker. Animations come out as WebP and everything else
as PNG.

A 7TV link brings the emote's name, so you can leave the name out. The bot
downloads the largest WebP 7TV has, which keeps any animation. When the 7TV
name doesn't work as an emoji name, the bot swaps the characters Fluxer
doesn't allow for underscores, and asks you for a name if fewer than two are
left.

### Names

Emoji names are 2 to 32 letters, digits and underscores. Sticker names are 2
to 30 characters and may contain spaces. The bot refuses a name the server
already has, or one that an open proposal uses.

### Sticker description and tags

Stickers also take `--desc` and `--tags`:

```
!sticker propose Happy Cat https://example.org/cat.png --desc A very happy cat --tags cat, happy
```

The description can be up to 500 characters. Tags are separated by commas, up
to 10 of them, each up to 30 characters. A flag takes everything after it, up
to the next flag. The image link is the exception. If you haven't attached the
image or linked it before the flags, the bot takes the first link after a flag
as the image, so this works too:

```
!sticker propose Happy Cat --desc A very happy cat https://example.org/cat.png
```

Otherwise the bot leaves links after a flag where they are, so a description
can link to the artist. The bot refuses any flag other than `--desc` and
`--tags`, which catches typos like `--tag`.

### Wide images

An image at least twice as wide as it is tall, or twice as tall as it is
wide, gets cut into a row of roughly square pieces, one emoji each. A 3:1
banner becomes three emojis. Emojis go up to 5 pieces and stickers up to 3.
The pieces are named `name_1`, `name_2` and so on for emojis, and `name 1`,
`name 2` for stickers. Type them next to each other, without spaces, and the
picture lines up again.

The pieces go in together or not at all. If Fluxer refuses one, the bot
deletes the ones it already added.

### How a vote works

The bot posts the proposal in the polls channel with the image and pings
`@here`. Members vote with ✅ or ❌. Each member has one vote, and reacting
with the other emoji moves it.

A proposal passes once enough members vote ✅ and there are more ✅ than ❌.
`threshold` in the `emoji` or `sticker` section of the
[settings](configuration.md#bot-settings) sets what enough means: a
share of the members who could see the polls channel when the proposal went
up. The bot rounds up, so with 10 members `0.5` asks for 5 and `0.75` for 8.
The default, `1`, asks for every one of them.

Bots don't count. The proposer does, and their own ✅ counts like anyone
else's.

The bot sets the bar when the proposal goes up. People who join later can
vote, but they don't raise it, and changing `threshold` doesn't move it for
votes already running.

The vote ends the moment it passes. Otherwise it closes after `votingHours`,
48 by default, and the emoji isn't added. Below `1`, a vote can pass before
everyone has voted. Above `0.5` that changes nothing, because the rest can't
outvote it, but at `0.5` or lower they could have. Members with
`emoji.decide` can end a vote sooner with `approve` or `reject`.

When a proposal passes, the bot adds the emoji and replies to the poll with
the result. If Fluxer refuses the image, or someone added an emoji with the
same name in the meantime, the reply says so.

The reply with the result pings the proposer. That and the `@here` on the
proposal are the only pings. An `@everyone`, `@here`, member or role mention
in a name, description, tag or reason shows as written but doesn't notify
anyone.

Each member can have 3 open proposals of each kind at a time. `maxOpenPerUser`
changes that.

## Polls

```
!poll Pizza tonight?
!poll "What do we eat?" "🍕 Pizza" "🍣 Sushi" "Tacos" 3h
!poll "Which nights work?" "Friday" "Saturday" "Sunday" 2d multi
```

| Command | Permission | What it does |
|---|---|---|
| `!poll <question>` | `polls.create` | Starts a poll in the channel you're in |
| `!polls` | | Lists open polls, with links to them |

Without quotes, the whole text is a yes or no question. With quotes, the first
quoted part is the question and the rest are the answers, 2 to 10 of them.
Questions can be up to 250 characters long and answers up to 80.

An answer that starts with an emoji uses that emoji for its votes. The others
get 1️⃣ to 🔟. Custom emojis have to come from this server, since the bot can't
react with anyone else's.

After the quotes you can add:

- a duration, like `30m`, `3h`, `2d`, `1w` or `1d12h`, between one minute and
  four weeks. Without one, the poll runs `defaultHours`, 24 by default.
- `multi`, which lets members pick several answers. Without it, picking a
  second answer moves the vote.

The bot posts the poll and deletes your command. Results update a few seconds
after each vote. React with 🛑 to end your poll early. Members with
`polls.end-any` can end anyone's, and the bot takes back 🛑 from everyone else.
Deleting the poll message calls the poll off.

When a poll ends, the bot replies to it with the winner and pings whoever
started it.

Each member can have 5 open polls at a time. `maxOpenPerUser` in the `polls`
section changes that.

## Role menus

Role menus have no commands. The bot posts them from the settings, as described
in [Configuration](configuration.md#role-menus). React to get a role, and
remove the reaction to drop it. In a menu where you pick one, picking another
swaps the role.

## Boards

Boards are set up with `!board create`, `edit` and `delete` below, or in the
`boards` section of the settings, described in
[Configuration](configuration.md#boards). Once enough members react to a
message with a board's emoji, the bot posts it in the board's channel with
the author, the text, the first image and a link back. A link to an image in
the text counts as an image. On a board that isn't NSFW, NSFW images come
blurred, as [Configuration](configuration.md#boards) describes. The author's own
reaction doesn't count, and neither do bots.

The post shows how many reacted and changes as that does. When the message is
edited, so is the post. When it's deleted, the post goes too. When reactions
drop below the threshold, the bot takes the post down, unless the board has
`keep` set.

Deleting a post takes the message off that board for good, the same as
`!board remove`.

| Command | Permission | What it does |
|---|---|---|
| `!board list` | | Lists the boards with their emoji, channel and threshold |
| `!board top [board]` | | Lists the 10 members with the most messages on a board, the first one in the settings by default |
| `!board optout` | | Keeps your messages off every board and takes down the ones already there |
| `!board optin` | | Lets your messages go up again |
| `!board remove <message>` | `boards.remove` | Takes a message off every board it's on, for good. Takes a link to the message or to a post, or either ID. Given a post, it only takes the message off that post's board. |
| `!board create <name> <emoji> <channel> [--threshold n] [--keep yes\|no] [--ignore channels]` | `boards.manage` | Adds a board |
| `!board edit <board> [--name name] [--emoji emoji] [--channel channel] [--threshold n] [--keep yes\|no] [--ignore channels]` | `boards.manage` | Changes a board. What you leave out stays as it is. |
| `!board delete <board>` | `boards.manage` | Deletes a board. Its posts stay in its channel, but the bot forgets them, so they no longer follow their messages or count for `!board top`. |

The options are the board's keys in the settings:

- `name`: lowercase letters, digits and hyphens, up to 32. Renaming a board
  keeps its posts and leaderboard.
- `emoji`: a Unicode emoji, or a custom one as `<:name:id>` or `name:id`.
- `channel`: where the bot posts. Mention it, like `#gems`, or give its ID.
- `--threshold`: how many members other than the author have to react, 5 by
  default.
- `--keep yes`: leaves a post up when reactions drop below the threshold
  again.
- `--ignore`: channels whose messages never go up on this board, mentioned or
  as IDs, separated by spaces or commas. `--ignore none` clears the list.

```
!board create gems 💎 #gems --threshold 5
!board edit gems --threshold 8 --ignore #staff #mod-log
!board delete coal
```

A change is a settings change, so `!settings log` lists it and the boards
start over, as [Configuration](configuration.md#changes-while-the-bot-runs)
describes.

## Settings

Only the guild owner and members with Administrator may run these, and
`!help` doesn't show them to anyone else. No permission rule can hand them
out. [Configuration](configuration.md#bot-settings) explains the settings.

| Command | Permission | What it does |
|---|---|---|
| `!settings export` | Owner or Administrator | Replies with the bot settings as `settings.json` |
| `!settings import <file>` | Owner or Administrator | Replaces all bot settings with the attached JSON file |
| `!settings log` | Owner or Administrator | Shows the last 30 changes to the settings: when, who, and which sections |

To change a setting, export the settings, edit the file, and import it again.
The file has to be attached to the `!settings import` message; the bot doesn't
take a link. It takes files up to 1 MiB.

The import replaces everything, so a section missing from the file turns its
feature off, and a key missing from a section goes back to its default. The
bot checks the whole file before it changes anything. If something is wrong,
the reply lists each problem with its path, and the settings stay as they
were:

```
/boards/1/threshold: Expected a value greater than or equal to 1
/pollsChannelId: emoji proposals need a channel to vote in; set it, or remove /emoji
```

Otherwise the reply names the sections that changed, and they apply right
away. A change to the prefix or the permissions applies to the next command.
Any other section starts its features over, as
[Configuration](configuration.md#changes-while-the-bot-runs) describes.

The bot records every change in the database: who made it, when, and each
changed section before and after. `!settings log` shows who, when and which
sections.
