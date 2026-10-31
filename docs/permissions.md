# Permissions

The `permissions` section of the [bot settings](configuration.md#bot-settings)
decides who may run which commands.
It has one list of rules for every member and one list per role:

```json
"permissions": {
  "everyone": ["+emoji.propose", "+sticker.propose", "+polls.create"],
  "roles": {
    "100000000000000010": ["+*"],
    "100000000000000011": ["+emoji.*", "+sticker.*", "+polls.end-any"],
    "100000000000000012": ["-polls.create"]
  }
}
```

Roles are keyed by role ID. Edit the section with `!settings export` and
`!settings import`, and the bot applies the new rules to the next command.

## What can be allowed

| Permission | What it allows |
|---|---|
| `emoji.propose` | Putting an emoji up for a vote with `!emoji propose` |
| `emoji.add` | Adding an emoji without a vote with `!emoji add` |
| `emoji.decide` | Approving or rejecting a proposal before its vote ends |
| `emoji.cancel-any` | Withdrawing anyone's proposal. Everyone can withdraw their own. |
| `sticker.propose`, `sticker.add`, `sticker.decide`, `sticker.cancel-any` | The same, for stickers |
| `polls.create` | Starting a poll with `!poll` |
| `polls.end-any` | Ending anyone's poll early with 🛑. Everyone can end their own. |
| `boards.remove` | Taking a message off the boards for good with `!board remove` |
| `boards.manage` | Creating, changing and deleting boards with `!board create`, `edit` and `delete`, or under Admin → Boards in the web interface |

Every member can run the other commands: `!help`, `!ping`, `!perms`, `!polls`,
`list` under `!emoji` and `!sticker`, and `list`, `top`, `optout` and `optin`
under `!board`. The exception is `!settings`, below.

## Who may change the settings

Only the guild owner and members with Administrator may run `!settings`,
which reads and changes the bot settings, these rules included. No rule can
hand that out, not even `+*`, so nobody can use it to give themselves more
than they have. The bot records every change with who made it, and
`!settings log` shows them.

## Writing rules

A rule is `+` to allow or `-` to deny, followed by one of these:

- a permission, like `emoji.add`
- a group, like `emoji.*`, which covers every permission in it
- `*`, which covers all of them

`everyone` applies to every member. Leave it out and members get the default,
`["+emoji.propose", "+sticker.propose", "+polls.create"]`. Setting it replaces
the default, so `"everyone": []` leaves members without a role unable to do
anything.

A list can name each permission or group only once. With both `+emoji.add`
and `-emoji.add` in one list, the bot refuses the settings.

## Who wins

The guild owner and members with Administrator may do everything, whatever
the rules say.

For everyone else, the bot looks at every rule that names the permission:

1. The most specific rule wins. A permission beats a group, and a group beats
   `*`.
2. Between rules that are just as specific, a role's rule beats Manage
   Expressions, which beats `everyone`. Between two roles, the higher one wins.
3. When no rule names the permission, the member doesn't have it.

Members with Manage Expressions get `+emoji.*` and `+sticker.*` on top of
their roles, since they can add emojis and stickers in the client anyway. A
role rule like `-emoji.add` takes that back, because it's more specific.

### Watch out for denials

Specificity counts before role order. Take a member who has the role with
`+*` from the example above and also the one with `-polls.create`. They can't
start polls, even if the `+*` role sits higher, because `-polls.create` names
the permission and `+*` doesn't.

To keep that from happening, give the admin role `+polls.create` as well, or
only put denials on roles your admins don't have. `!perms` shows which rule
won.

## Examples

Only curators may propose emojis:

```json
"permissions": {
  "everyone": ["+sticker.propose", "+polls.create"],
  "roles": {
    "100000000000000011": ["+emoji.propose"]
  }
}
```

Moderators decide proposals and end polls, but can't skip the vote:

```json
"roles": {
  "100000000000000013": ["+emoji.*", "+sticker.*", "-emoji.add", "-sticker.add", "+polls.end-any"]
}
```

A role that can't start polls:

```json
"roles": {
  "100000000000000012": ["-polls.create"]
}
```

## Checking a member

`!perms` shows what you may do, and `!perms @someone` shows it for someone
else. Each line names the permission, whether the member has it, and the rule
that decided:

```
✅ emoji.add: +emoji.* on @Curators
❌ emoji.decide: -emoji.decide on @Helpers
❌ polls.end-any: no rule allows it
```

Permissions of features that are turned off don't show up.

When the bot logs in, and again whenever the permissions change, it logs a
warning for every role ID in `permissions.roles` that the guild doesn't have.
