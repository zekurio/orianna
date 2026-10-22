import { describe, expect, test } from "bun:test";
import type { Attachment, OptionSpec } from "./command.ts";
import { ArgumentError, nextWord, parseOptions } from "./options.ts";

const image: Attachment = {
  url: "https://media.example.org/a.png",
  filename: "a.png",
  contentType: "image/png",
  size: 1234,
};

describe("nextWord", () => {
  test("splits off the first word and keeps the rest verbatim", () => {
    expect(nextWord("  propose  party_cat ")).toEqual({
      word: "propose",
      rest: "  party_cat ",
    });
  });

  test("returns null for blank input", () => {
    expect(nextWord("   ")).toBeNull();
  });
});

describe("parseOptions", () => {
  const propose: OptionSpec[] = [
    { name: "name", description: "", type: "string" },
    { name: "image", description: "", type: "attachment" },
  ];

  test("fills words and attachments in order", () => {
    expect(parseOptions(propose, " party_cat", [image])).toEqual({
      name: "party_cat",
      image,
    });
  });

  test("reports the first missing required option", () => {
    expect(() => parseOptions(propose, "", [image])).toThrow("missing name");
    expect(() => parseOptions(propose, "party_cat", [])).toThrow("missing image");
  });

  test("rejects leftover words", () => {
    expect(() => parseOptions(propose, "party cat", [image])).toThrow(
      "unexpected argument: cat",
    );
  });

  test("omits optional options that are absent", () => {
    const specs: OptionSpec[] = [
      { name: "id", description: "", type: "integer" },
      { name: "reason", description: "", type: "string", required: false, rest: true },
    ];
    expect(parseOptions(specs, "42", [])).toEqual({ id: 42 });
  });

  test("rest options keep inner whitespace", () => {
    const specs: OptionSpec[] = [
      { name: "id", description: "", type: "integer" },
      { name: "reason", description: "", type: "string", rest: true },
    ];
    expect(parseOptions(specs, "7  too  blurry\nsorry ", [])).toEqual({
      id: 7,
      reason: "too  blurry\nsorry",
    });
  });

  test("validates integers", () => {
    const specs: OptionSpec[] = [{ name: "id", description: "", type: "integer" }];
    expect(parseOptions(specs, "-3", [])).toEqual({ id: -3 });
    expect(() => parseOptions(specs, "3.5", [])).toThrow(ArgumentError);
    expect(() => parseOptions(specs, "abc", [])).toThrow("id must be a whole number");
  });
});
