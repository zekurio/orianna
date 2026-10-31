import { CaretDownIcon, MagnifyingGlassIcon, SmileyIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { type ComponentProps, type KeyboardEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "../App.tsx";
import type { UnicodeEmoji } from "../../rpc.ts";
import { emojiImage, findUnicodeEmoji, useUnicodeEmojis } from "../emojis.ts";

// Picks an emoji the way Fluxer shows them: the picture and its `:name:`.
// The server's own emoji come first, then Fluxer's categories. The value is
// what a message holds: the Unicode emoji, or `<:name:id>` for a custom one.

/** A custom emoji of the server. */
export interface ServerEmoji {
  /** As a message holds it, `<:name:id>` or `<a:name:id>`. */
  text: string;
  name: string;
  url: string;
}

/** One emoji in the picker, whichever kind. */
interface Choice {
  value: string;
  name: string;
  image: string;
}

export function EmojiPicker({
  value,
  server,
  fallbackImage,
  onChange,
  onClose,
  ...trigger
}: {
  value: string;
  server: readonly ServerEmoji[];
  /** The picture of a custom emoji the server doesn't have anymore. */
  fallbackImage?: string | null;
  onChange: (value: string) => void;
  /** The picker closed, picked or not. */
  onClose?: () => void;
} & Pick<ComponentProps<"button">, "id" | "aria-invalid" | "aria-describedby">) {
  const { emojiImages } = useSession();
  const categories = useUnicodeEmojis();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<Choice>();

  const unicode = (emoji: UnicodeEmoji): Choice => ({
    value: emoji.unicode,
    name: emoji.name,
    image: emojiImage(emojiImages, emoji.unicode),
  });
  const custom = server.map((emoji): Choice => ({ value: emoji.text, name: emoji.name, image: emoji.url }));

  // The current emoji, as the trigger shows it.
  const current = useMemo((): Choice | undefined => {
    if (!value) return undefined;
    const own = custom.find((emoji) => emoji.value === value);
    if (own) return own;
    const gone = /^<a?:(\w+):\d+>$/.exec(value);
    if (gone) return { value, name: gone[1]!, image: fallbackImage ?? "" };
    const found = categories && findUnicodeEmoji(categories, value);
    return { value, name: found?.name ?? "", image: emojiImage(emojiImages, value) };
  }, [value, server, categories, fallbackImage, emojiImages]);

  const sections = useMemo(() => {
    const term = query.trim().toLowerCase().replace(/^:|:$/g, "");
    const all = [
      ...(custom.length > 0 ? [{ label: "This server", choices: custom }] : []),
      ...(categories ?? []).map(({ label, emojis }) => ({ label, choices: emojis.map(unicode) })),
    ];
    if (!term) return all;
    const matches = (choice: Choice, terms: readonly string[]) =>
      choice.name.toLowerCase().includes(term) || terms.some((t) => t.includes(term));
    const found = [
      ...custom.filter((choice) => matches(choice, [])),
      ...(categories ?? []).flatMap(({ emojis }) =>
        emojis.filter((emoji) => matches(unicode(emoji), emoji.terms)).map(unicode),
      ),
    ];
    return [{ label: "Results", choices: found }];
  }, [query, server, categories, emojiImages]);

  const pick = (choice: Choice) => {
    onChange(choice.value);
    setOpen(false);
  };
  const first = sections[0]?.choices[0];
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && query && first) {
      event.preventDefault();
      pick(first);
    }
  };
  const preview = hovered ?? current;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setHovered(undefined);
          onClose?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 w-full justify-start gap-2 px-3 font-normal" {...trigger}>
          {current ? (
            <>
              <EmojiImage key={current.value} choice={current} />
              <span className="truncate">{current.name ? `:${current.name}:` : current.value}</span>
            </>
          ) : (
            <>
              <SmileyIcon className="text-muted-foreground" />
              <span className="text-muted-foreground">Pick an emoji</span>
            </>
          )}
          <CaretDownIcon className="ml-auto text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="relative border-b p-2">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-4.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Find an emoji"
            aria-label="Find an emoji"
            className="pl-8"
          />
        </div>
        <div className="h-72 overflow-y-auto px-2 pb-2" onMouseLeave={() => setHovered(undefined)}>
          {!categories && (
            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Spinner />
              Loading emoji…
            </p>
          )}
          {sections.map(({ label, choices }) => (
            <section key={label} aria-label={label}>
              <h3 className="sticky top-0 z-10 bg-popover pt-2 pb-1 font-sans text-xs font-medium text-muted-foreground">
                {label}
              </h3>
              <div className="grid grid-cols-8 gap-0.5">
                {choices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    title={`:${choice.name}:`}
                    aria-label={`:${choice.name}:`}
                    aria-pressed={choice.value === value}
                    onClick={() => pick(choice)}
                    onMouseEnter={() => setHovered(choice)}
                    onFocus={() => setHovered(choice)}
                    className={cn(
                      "grid aspect-square place-items-center rounded-md hover:bg-accent focus-visible:bg-accent",
                      choice.value === value && "bg-primary/15",
                    )}
                  >
                    <EmojiImage choice={choice} size="size-6" lazy />
                  </button>
                ))}
              </div>
            </section>
          ))}
          {query && sections[0]?.choices.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">No emoji called that.</p>
          )}
        </div>
        <div className="flex h-12 items-center gap-2.5 border-t px-3 text-sm">
          {preview ? (
            <>
              <EmojiImage key={preview.value} choice={preview} size="size-7" />
              <span className="truncate">{preview.name ? `:${preview.name}:` : preview.value}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Pick one, or search by name.</span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * An emoji's picture. Twemoji keeps U+FE0F in the file name of nearly every
 * sequence joined with U+200D, but not all, so a missing one is tried without
 * it; then the character stands in.
 */
function EmojiImage({ choice, size = "size-5", lazy }: { choice: Choice; size?: string; lazy?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const sources = [choice.image, choice.image.replace(/-fe0f(?=[-.])/g, "")].filter(
    (source, i, all) => source && all.indexOf(source) === i,
  );
  const source = sources[attempt];
  if (!source) {
    return <span className={cn(size, "grid shrink-0 place-items-center leading-none")}>{choice.value}</span>;
  }
  return (
    <img
      key={source}
      src={source}
      alt={`:${choice.name}:`}
      loading={lazy ? "lazy" : undefined}
      draggable={false}
      onError={() => setAttempt((n) => n + 1)}
      className={cn(size, "shrink-0 object-contain")}
    />
  );
}
