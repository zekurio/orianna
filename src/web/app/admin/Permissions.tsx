import { PlusIcon, TrashIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGuild } from "../guild.tsx";
import { differs, problemAt, problemsUnder, type SectionProps, type Settings, SettingsCard, useSave } from "./shared.tsx";

// Who may do what: rules like `+emoji.add` or `-polls.*` for everyone and per
// role, the `permissions` section of the settings. The bot works out which
// rule decides; src/permissions/rules.ts says how.

type Permissions = Settings["permissions"];
type Role = SectionProps["setup"]["roles"][number];

/** What a rule can name, with how the form shows it. */
interface Target {
  value: string;
  label: string;
}

/** Every permission, each group like `emoji.*`, and `*`, in that order. */
function targetsOf(permissions: readonly string[]): Target[] {
  const groups = [...new Set(permissions.map((p) => p.slice(0, p.indexOf("."))))];
  return [
    ...permissions.map((p) => ({ value: p, label: p })),
    ...groups.map((g) => ({ value: `${g}.*`, label: `All of ${g} (${g}.*)` })),
    { value: "*", label: "Everything (*)" },
  ];
}

export function PermissionsSection({ setup, settings }: SectionProps) {
  const { prefix } = useGuild();
  const { save, busy, problems } = useSave("permissions");
  const [draft, setDraft] = useState<Permissions>(settings.permissions);
  const targets = targetsOf(setup.permissions);
  const roleById = new Map(setup.roles.map((r) => [r.id, r]));
  const unlisted = setup.roles.filter((r) => !(r.id in draft.roles));

  // Problems shown next to a list or a rule; the card shows the rest.
  const shown = new Set<string>();
  const at = (path: string) => {
    const problem = problemAt(problems, path);
    if (problem) shown.add(`${path}: ${problem}`);
    return problem;
  };

  const setEveryone = (everyone: string[]) => setDraft((d) => ({ ...d, everyone }));
  const setRole = (id: string, rules: string[]) => setDraft((d) => ({ ...d, roles: { ...d.roles, [id]: rules } }));
  const removeRole = (id: string) =>
    setDraft((d) => ({ ...d, roles: Object.fromEntries(Object.entries(d.roles).filter(([other]) => other !== id)) }));

  const lists = (
    <>
      <RuleList
        title={
          <span className="flex items-center gap-2">
            <UsersThreeIcon />
            Everyone
          </span>
        }
        hint="Every member, whatever their roles."
        path="/permissions/everyone"
        rules={draft.everyone}
        targets={targets}
        problemAt={at}
        onChange={setEveryone}
      />
      {Object.entries(draft.roles).map(([id, rules]) => (
        <RuleList
          key={id}
          title={<RoleName id={id} role={roleById.get(id)} />}
          path={`/permissions/roles/${id}`}
          rules={rules}
          targets={targets}
          problemAt={at}
          onChange={(next) => setRole(id, next)}
          onRemove={() => removeRole(id)}
        />
      ))}
    </>
  );

  return (
    <SettingsCard
      title="Permissions"
      description={
        <>
          A rule allows (<code>+</code>) or denies (<code>-</code>) a permission, a group like <code>emoji.*</code>,
          or <code>*</code> for everything. The most specific rule that names a permission decides it. Between rules
          that are just as specific, a role's beats Manage Expressions, which beats everyone's, and a higher role beats
          a lower one. A permission no rule names is denied. The server owner and members with Administrator may do
          everything. <code>{prefix}perms</code> shows what a member may do, and why.
        </>
      }
      dirty={differs(draft, settings.permissions)}
      busy={busy}
      problems={problemsUnder(problems, "/permissions").filter((p) => !shown.has(p))}
      onSave={() => save({ permissions: draft })}
      onReset={() => setDraft(settings.permissions)}
    >
      {lists}
      {unlisted.length > 0 && (
        <Field className="sm:max-w-xs">
          {/* Keyed by how many roles have rules, so it's empty again after picking one. */}
          <Select key={Object.keys(draft.roles).length} onValueChange={(id) => setRole(id, [])}>
            <SelectTrigger className="w-full" aria-label="Add rules for a role">
              <PlusIcon />
              <SelectValue placeholder="Add rules for a role" />
            </SelectTrigger>
            <SelectContent>
              {unlisted.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  <RoleName id={role.id} role={role} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </SettingsCard>
  );
}

function RoleName({ id, role }: { id: string; role: Role | undefined }) {
  if (!role) return <span className="text-muted-foreground">Unknown role {id}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
        // A role's own colour, which the theme can't know; 0 is none.
        style={role.color ? { backgroundColor: `#${role.color.toString(16).padStart(6, "0")}` } : undefined}
      />
      <span className="truncate">{role.name}</span>
    </span>
  );
}

/** The rules of everyone or of one role. */
function RuleList({
  title,
  hint,
  path,
  rules,
  targets,
  problemAt,
  onChange,
  onRemove,
}: {
  title: ReactNode;
  hint?: string;
  /** Where the bot's problems with this list point, like `/permissions/everyone`. */
  path: string;
  rules: readonly string[];
  targets: readonly Target[];
  problemAt: (path: string) => string | undefined;
  onChange: (rules: string[]) => void;
  /** Removes the list, for a role's. */
  onRemove?: () => void;
}) {
  const used = new Set(rules.map((r) => r.slice(1)));
  const free = targets.filter((t) => !used.has(t.value));
  const listProblem = problemAt(path);
  const set = (i: number, rule: string) => onChange(rules.map((r, j) => (j === i ? rule : r)));

  return (
    <FieldSet className="gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <FieldLegend className="mb-0 min-w-0">{title}</FieldLegend>
        {onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            <TrashIcon />
            Remove role
          </Button>
        )}
      </div>
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {rules.length === 0 && <p className="text-sm text-muted-foreground">No rules.</p>}
      <ul className="flex flex-col gap-3">
        {rules.map((rule, i) => {
          const sign = rule[0] === "-" ? "-" : "+";
          const target = rule[0] === "+" || rule[0] === "-" ? rule.slice(1) : rule;
          const known = targets.some((t) => t.value === target);
          const problem = problemAt(`${path}/${i}`);
          return (
            <li key={i}>
              <Field data-invalid={problem ? true : undefined} className="gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={sign} onValueChange={(next) => set(i, `${next}${target}`)}>
                    <SelectTrigger className="w-28" aria-label="Allow or deny" aria-invalid={problem ? true : undefined}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="+">Allow</SelectItem>
                      <SelectItem value="-">Deny</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={target} onValueChange={(next) => set(i, `${sign}${next}`)}>
                    <SelectTrigger
                      className="min-w-0 flex-1 basis-48"
                      aria-label="Permission"
                      aria-invalid={problem ? true : undefined}
                    >
                      <SelectValue placeholder="Pick a permission" />
                    </SelectTrigger>
                    <SelectContent>
                      {!known && target !== "" && <SelectItem value={target}>{target}</SelectItem>}
                      {targets
                        .filter((t) => t.value === target || !used.has(t.value))
                        .map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove rule"
                    onClick={() => onChange(rules.filter((_, j) => j !== i))}
                  >
                    <TrashIcon />
                  </Button>
                </div>
                <FieldError>{problem}</FieldError>
              </Field>
            </li>
          );
        })}
      </ul>
      {listProblem && <FieldError>{listProblem}</FieldError>}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={free.length === 0}
          onClick={() => onChange([...rules, `+${free[0]!.value}`])}
        >
          <PlusIcon />
          Add rule
        </Button>
      </div>
    </FieldSet>
  );
}
