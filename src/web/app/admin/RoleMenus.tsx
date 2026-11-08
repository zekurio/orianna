import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { EmojiPicker } from "@/components/EmojiPicker";
import { SettingRow, SettingsGroup } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { RoleMenuConfig, RoleMenusConfig } from "../../../config.ts";
import {
  differs,
  type Problems,
  problemAt,
  problemsUnder,
  type SectionProps,
  SettingsForm,
  useSave,
} from "./shared.tsx";

// Role menus: messages where members react to give themselves roles, the
// `roleMenus` section of the settings. The bot posts and updates them when
// the section changes. Optional keys stay out of the draft while they're
// empty, since the bot refuses empty descriptions.

type Menu = RoleMenuConfig;
type Option = Menu["options"][number];

/** A menu's channel when it uses the default one; Select can't take an empty value. */
const DEFAULT_CHANNEL = "default";

/** A message can carry 30 different reactions. */
const MAX_OPTIONS = 30;

const ROOT = "/roleMenus";

const emptyOption = (): Option => ({ emoji: "", roleId: "" });
const emptyMenu = (): Menu => ({ name: "", title: "", mode: "multi", options: [emptyOption()] });

/** `value`, or no key at all while it's empty. */
function optional<K extends string>(key: K, value: string): { [P in K]?: string } {
  return (value === "" ? {} : { [key]: value }) as { [P in K]?: string };
}

export function RoleMenusSection({ setup, settings }: SectionProps) {
  const saved = settings.roleMenus;
  const [draft, setDraft] = useState<RoleMenusConfig | undefined>(saved);
  const { save, busy, problems } = useSave("role menus");
  const id = useId();

  const turn = (on: boolean) =>
    setDraft(on ? (saved ?? { channelId: setup.channels[0]?.id ?? "", menus: [emptyMenu()] }) : undefined);
  const setMenus = (menus: readonly Menu[]) => draft && setDraft({ ...draft, menus });
  const setMenu = (i: number, menu: Menu) => draft && setMenus(draft.menus.with(i, menu));

  // The problems no field shows, like ones about a whole menu or option.
  const shownHere = (problem: string) =>
    /^\/roleMenus\/(channelId|menus\/\d+\/(name|title|description|mode|channelId|options|options\/\d+\/(emoji|roleId|description))): /.test(
      problem,
    );
  const rest = problemsUnder(problems, ROOT).filter((p) => !draft || !shownHere(p));

  return (
    <SettingsForm
      dirty={differs(draft, saved)}
      busy={busy}
      problems={rest}
      onSave={() => save({ roleMenus: draft ?? null })}
      onReset={() => setDraft(saved)}
    >
      <SettingsGroup title="Role menus">
        <SettingRow
          id={`${id}-on`}
          title="Post role menus"
          description="The bot's role has to be above the roles it gives."
          control={<Switch id={`${id}-on`} checked={draft !== undefined} onCheckedChange={turn} />}
        />
        {draft && (
          <SettingRow
            id={`${id}-channel`}
            title="Default channel"
            wide
            problem={problemAt(problems, `${ROOT}/channelId`)}
            control={
              <ChannelSelect
                id={`${id}-channel`}
                value={draft.channelId}
                channels={setup.channels}
                onChange={(channelId) => setDraft({ ...draft, channelId })}
              />
            }
          />
        )}
      </SettingsGroup>

      {draft && (
        <>
          {draft.menus.map((menu, i) => (
            <MenuEditor
              // By position: names change while they're typed.
              key={i}
              menu={menu}
              at={`${ROOT}/menus/${i}`}
              setup={setup}
              problems={problems}
              onChange={(next) => setMenu(i, next)}
              onRemove={() => setMenus(draft.menus.filter((_, j) => j !== i))}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setMenus([...draft.menus, emptyMenu()])}
          >
            <PlusIcon />
            Add menu
          </Button>
        </>
      )}
    </SettingsForm>
  );
}

function MenuEditor({
  menu,
  at,
  setup,
  problems,
  onChange,
  onRemove,
}: {
  menu: Menu;
  /** Its path in the settings, like `/roleMenus/menus/0`. */
  at: string;
  setup: SectionProps["setup"];
  problems: Problems;
  onChange: (menu: Menu) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const problem = (key: string) => problemAt(problems, `${at}/${key}`);
  const invalid = (key: string) => (problem(key) ? true : undefined);
  const setOption = (j: number, option: Option) => onChange({ ...menu, options: menu.options.with(j, option) });
  const { description: _description, ...withoutDescription } = menu;
  const { channelId: _channelId, ...withoutChannel } = menu;

  return (
    <SettingsGroup
      title={menu.title || menu.name || "New menu"}
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <TrashIcon />
          Remove menu
        </Button>
      }
    >
      <SettingRow
        id={`${id}-name`}
        title="Name"
        wide
        description="Lowercase letters, digits and hyphens. Renaming reposts the menu."
        problem={problem("name")}
        control={
          <Input
            id={`${id}-name`}
            value={menu.name}
            onChange={(e) => onChange({ ...menu, name: e.target.value.toLowerCase() })}
            placeholder="notifications"
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid("name")}
            aria-describedby={`${id}-name-description`}
            className="w-full sm:w-56"
          />
        }
      />
      <SettingRow
        id={`${id}-title`}
        title="Title"
        wide
        problem={problem("title")}
        control={
          <Input
            id={`${id}-title`}
            value={menu.title}
            onChange={(e) => onChange({ ...menu, title: e.target.value })}
            placeholder="Notifications"
            maxLength={256}
            aria-invalid={invalid("title")}
            className="w-full sm:w-56"
          />
        }
      />
      <SettingRow id={`${id}-description`} title="Description" description="Optional." problem={problem("description")}>
        <Textarea
          id={`${id}-description`}
          value={menu.description ?? ""}
          onChange={(e) => onChange({ ...withoutDescription, ...optional("description", e.target.value) })}
          placeholder="Pick what you'd like to be pinged for."
          maxLength={1000}
          aria-invalid={invalid("description")}
          aria-describedby={`${id}-description-description`}
        />
      </SettingRow>
      <SettingRow
        id={`${id}-mode`}
        title="Members can take"
        wide
        problem={problem("mode")}
        control={
          <Select value={menu.mode} onValueChange={(mode) => onChange({ ...menu, mode: mode as Menu["mode"] })}>
            <SelectTrigger id={`${id}-mode`} className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="multi">Any number of roles</SelectItem>
              <SelectItem value="single">One at a time</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingRow
        id={`${id}-channel`}
        title="Channel"
        wide
        problem={problem("channelId")}
        control={
          <ChannelSelect
            id={`${id}-channel`}
            value={menu.channelId ?? DEFAULT_CHANNEL}
            channels={setup.channels}
            withDefault
            onChange={(channelId) => onChange(channelId === DEFAULT_CHANNEL ? withoutChannel : { ...menu, channelId })}
          />
        }
      />
      <SettingRow title="Roles" problem={problem("options")}>
        <ul className="flex flex-col gap-3">
          {menu.options.map((option, j) => (
            <OptionRow
              key={j}
              option={option}
              at={`${at}/options/${j}`}
              setup={setup}
              problems={problems}
              onChange={(next) => setOption(j, next)}
              onRemove={() => onChange({ ...menu, options: menu.options.filter((_, k) => k !== j) })}
            />
          ))}
        </ul>
        <Button
          type="button"
          variant="ghost"
          className="-ml-2.5 self-start text-muted-foreground"
          disabled={menu.options.length >= MAX_OPTIONS}
          onClick={() => onChange({ ...menu, options: [...menu.options, emptyOption()] })}
        >
          <PlusIcon />
          Add role
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}

function OptionRow({
  option,
  at,
  setup,
  problems,
  onChange,
  onRemove,
}: {
  option: Option;
  at: string;
  setup: SectionProps["setup"];
  problems: Problems;
  onChange: (option: Option) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const problem = (key: string) => problemAt(problems, `${at}/${key}`);
  const invalid = (key: string) => (problem(key) ? true : undefined);
  const known = setup.roles.some((r) => r.id === option.roleId);
  const { description: _description, ...withoutDescription } = option;

  return (
    <li className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
      <Field data-invalid={invalid("emoji")}>
        <FieldLabel htmlFor={`${id}-emoji`} className="sm:sr-only">
          Emoji
        </FieldLabel>
        <EmojiPicker
          id={`${id}-emoji`}
          aria-invalid={invalid("emoji")}
          value={option.emoji}
          server={setup.emojis}
          onChange={(emoji) => onChange({ ...option, emoji })}
        />
        <FieldError>{problem("emoji")}</FieldError>
      </Field>

      <Field data-invalid={invalid("roleId")}>
        <FieldLabel htmlFor={`${id}-role`} className="sm:sr-only">
          Role
        </FieldLabel>
        <Select value={option.roleId} onValueChange={(roleId) => onChange({ ...option, roleId })}>
          <SelectTrigger id={`${id}-role`} className="w-full" aria-invalid={invalid("roleId")}>
            <SelectValue placeholder="Pick a role" />
          </SelectTrigger>
          <SelectContent>
            {!known && option.roleId !== "" && <SelectItem value={option.roleId}>Unknown role</SelectItem>}
            {setup.roles.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                @{role.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError>{problem("roleId")}</FieldError>
      </Field>

      <Field data-invalid={invalid("description")}>
        <FieldLabel htmlFor={`${id}-description`} className="sm:sr-only">
          Description
        </FieldLabel>
        <Input
          id={`${id}-description`}
          value={option.description ?? ""}
          onChange={(e) => onChange({ ...withoutDescription, ...optional("description", e.target.value) })}
          placeholder="Optional, shown after the role"
          maxLength={100}
          aria-invalid={invalid("description")}
        />
        <FieldError>{problem("description")}</FieldError>
      </Field>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-destructive hover:text-destructive max-sm:justify-self-end"
        aria-label="Remove role"
        onClick={onRemove}
      >
        <TrashIcon />
      </Button>
    </li>
  );
}

function ChannelSelect({
  id,
  value,
  channels,
  withDefault = false,
  onChange,
}: {
  id: string;
  value: string;
  channels: SectionProps["setup"]["channels"];
  /** Offer the section's default channel, as {@link DEFAULT_CHANNEL}. */
  withDefault?: boolean;
  onChange: (channelId: string) => void;
}) {
  const known = value === DEFAULT_CHANNEL || channels.some((c) => c.id === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full sm:w-56">
        <SelectValue placeholder="Pick a channel" />
      </SelectTrigger>
      <SelectContent>
        {withDefault && <SelectItem value={DEFAULT_CHANNEL}>Default channel</SelectItem>}
        {!known && value !== "" && <SelectItem value={value}>A channel you can't see</SelectItem>}
        {channels.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            #{c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
