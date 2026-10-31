import { Effect } from "effect";
import { defineCommand, refuse } from "../commands/command.ts";
import { AppConfig } from "../config.ts";
import { ACCENT } from "../messages/body.ts";
import { type Decision, GuildAccess, groupOf, PERMISSIONS, type Permission } from "./rules.ts";

/** `<@id>`, `<@!id>` or a bare ID. */
const MEMBER = /^(?:<@!?(\d+)>|(\d+))$/;

export const perms = defineCommand({
  name: "perms",
  description: "Show what you or another member may do, and which rule decides it.",
  options: [
    {
      name: "member",
      description: "A mention or user ID; you by default",
      type: "string",
      required: false,
    },
  ],
  run: (ctx) =>
    Effect.gen(function* () {
      const userId = ctx.options.member === undefined ? ctx.userId : yield* memberId(ctx.options.member);
      const permissions = yield* (yield* GuildAccess).permissionsOf(userId);
      const config = yield* AppConfig.current;

      let description: string;
      if (permissions.bypass) {
        const why = permissions.bypass === "owner" ? "owns the server" : "has Administrator";
        description = `<@${userId}> ${why}, so the rules don't apply and they may do everything.`;
      } else {
        // Permissions of features that are turned off would only add noise.
        const lines = PERMISSIONS.filter((p) => config[groupOf(p)] !== undefined).map((p) =>
          describe(p, permissions.decide(p)),
        );
        description = [`What <@${userId}> may do:`, ...lines].join("\n");
      }
      yield* ctx.reply({ embeds: [{ title: "Permissions", description, color: ACCENT }] });
    }),
});

function memberId(input: string) {
  const match = MEMBER.exec(input);
  if (!match) return refuse(`${input} isn't a mention or a user ID.`);
  return Effect.succeed((match[1] ?? match[2])!);
}

/** e.g. "✅ `emoji.add`: `+emoji.*` on @Curators" */
function describe(permission: Permission, decision: Decision): string {
  const mark = decision.allowed ? "✅" : "❌";
  const { rule, source } = decision;
  if (!rule || !source) return `${mark} \`${permission}\`: no rule allows it`;

  const from =
    source.kind === "role"
      ? `on <@&${source.roleId}>`
      : source.kind === "manage-expressions"
        ? "for Manage Expressions"
        : "for everyone";
  return `${mark} \`${permission}\`: \`${rule}\` ${from}`;
}
