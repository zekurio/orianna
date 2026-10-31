import { Context, type Effect } from "effect";
import type { UserError } from "../commands/command.ts";
import type { PermissionsConfig } from "../config.ts";
import type { FluxerError } from "../fluxer.ts";

// Who may do what. The settings hold rules like `+emoji.add` or `-polls.*` for
// everyone and per role; MemberPermissions works out which rule decides a
// permission for a member. permissions/fluxer.ts looks up the member.

/** Everything a rule can allow or deny. src/config.ts says what each one does. */
export const PERMISSIONS = [
  "emoji.propose",
  "emoji.add",
  "emoji.decide",
  "emoji.cancel-any",
  "sticker.propose",
  "sticker.add",
  "sticker.decide",
  "sticker.cancel-any",
  "polls.create",
  "polls.end-any",
  "boards.remove",
  "boards.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Named after the settings section that turns the feature on. */
export type PermissionGroup = "emoji" | "sticker" | "polls" | "boards";

export function groupOf(permission: Permission): PermissionGroup {
  return permission.slice(0, permission.indexOf(".")) as PermissionGroup;
}

/** What a rule can name: a permission, a group like `emoji.*`, or `*` for all of them. */
const TARGETS = new Set<string>([
  ...PERMISSIONS,
  ...PERMISSIONS.map((p) => `${groupOf(p)}.*`),
  "*",
]);

/** Why a rule from the settings can't be used, or undefined when it can. */
export function ruleProblem(rule: string): string | undefined {
  if (rule[0] !== "+" && rule[0] !== "-") {
    return `${rule} must start with + to allow or - to deny`;
  }
  const target = rule.slice(1);
  if (!TARGETS.has(target)) {
    return `${target} is not a permission; use one of ${PERMISSIONS.join(", ")}, a group like polls.*, or *`;
  }
  return undefined;
}

/**
 * Members with Manage Expressions can add and delete emojis and stickers in the
 * client anyway. Role rules can still take these away.
 */
const MANAGE_EXPRESSIONS_RULES = ["+emoji.*", "+sticker.*"];

/** Where a rule comes from, to explain a decision. */
export type RuleSource =
  | { kind: "everyone" }
  | { kind: "manage-expressions" }
  | { kind: "role"; roleId: string };

export interface RuleSet {
  source: RuleSource;
  rules: readonly string[];
}

export interface Decision {
  allowed: boolean;
  /** The rule that decided, with where it came from; unset when no rule names the permission. */
  rule?: string;
  source?: RuleSource;
}

/** Why a member may do everything, whatever the rules say. */
export type Bypass = "owner" | "administrator";

/** What the guild knows about a member, as far as rules are concerned. */
export interface MemberFacts {
  /** The member's roles, lowest first. */
  roleIds: readonly string[];
  manageExpressions: boolean;
}

/** The rule sets that apply to a member, weakest first. */
export function ruleSets(config: PermissionsConfig, member: MemberFacts): RuleSet[] {
  const sets: RuleSet[] = [{ source: { kind: "everyone" }, rules: config.everyone }];
  if (member.manageExpressions) {
    sets.push({ source: { kind: "manage-expressions" }, rules: MANAGE_EXPRESSIONS_RULES });
  }
  for (const roleId of member.roleIds) {
    const rules = config.roles[roleId];
    if (rules) sets.push({ source: { kind: "role", roleId }, rules });
  }
  return sets;
}

/** What one member may do. */
export class MemberPermissions {
  /** `sets` from {@link ruleSets}, weakest first. */
  constructor(
    readonly bypass: Bypass | null,
    private readonly sets: readonly RuleSet[],
  ) {}

  /**
   * The most specific rule naming the permission decides: `-emoji.add` beats
   * `+emoji.*`, which beats `+*`. Between rules just as specific, the later
   * set wins, so a higher role beats a lower one. Without a rule it's denied.
   */
  decide(permission: Permission): Decision {
    if (this.bypass) return { allowed: true };

    let decision: Decision = { allowed: false };
    let best = -1;
    for (const { source, rules } of this.sets) {
      for (const rule of rules) {
        const level = specificity(rule.slice(1), permission);
        if (level < 0 || level < best) continue;
        best = level;
        decision = { allowed: rule[0] === "+", rule, source };
      }
    }
    return decision;
  }

  has(permission: Permission): boolean {
    return this.decide(permission).allowed;
  }
}

/** 2 when the target is the permission, 1 for its group, 0 for `*`, -1 when it doesn't match. */
function specificity(target: string, permission: Permission): number {
  if (target === permission) return 2;
  if (target === `${groupOf(permission)}.*`) return 1;
  if (target === "*") return 0;
  return -1;
}

/** Answers what members of the bot's guild may do. */
export class GuildAccess extends Context.Service<
  GuildAccess,
  {
    /** Fails with a UserError when the user isn't a member. */
    readonly permissionsOf: (userId: string) => Effect.Effect<MemberPermissions, UserError | FluxerError>;
    readonly can: (
      userId: string,
      permission: Permission,
    ) => Effect.Effect<boolean, UserError | FluxerError>;
    /** Role IDs with rules in the settings that the guild doesn't have. */
    readonly unknownRoles: Effect.Effect<string[], FluxerError>;
  }
>()("orianna/GuildAccess") {}
