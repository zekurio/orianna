import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig, readToken } from "./config.ts";

describe("parseConfig", () => {
  test("applies defaults", () => {
    const config = parseConfig({
      instance: "https://chat.example.org",
      guildId: "123",
    });
    expect(config.prefix).toBe("!");
    expect(config.database).toBe("./data/orianna.db");
  });

  test("rejects unknown keys so typos surface", () => {
    expect(() =>
      parseConfig({ instance: "https://x", guildId: "123", prefx: "?" }),
    ).toThrow("/: unknown key(s): prefx");
  });

  test("requires snowflakes as numeric strings", () => {
    expect(() => parseConfig({ instance: "https://x", guildId: 123 })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ instance: "https://x", guildId: "abc" })).toThrow(
      ConfigError,
    );
  });

  test("lists every problem in the error", () => {
    try {
      parseConfig({});
      throw new Error("expected parseConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("instance");
      expect((err as Error).message).toContain("guildId");
    }
  });
});

describe("readToken", () => {
  test("prefers the systemd credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orianna-"));
    writeFileSync(join(dir, "token"), "from-credential\n");
    const token = await readToken({
      CREDENTIALS_DIRECTORY: dir,
      ORIANNA_TOKEN: "from-env",
    });
    expect(token).toBe("from-credential");
  });

  test("falls back to ORIANNA_TOKEN", async () => {
    expect(await readToken({ ORIANNA_TOKEN: " from-env " })).toBe("from-env");
  });

  test("fails without any token", async () => {
    await expect(readToken({})).rejects.toThrow(ConfigError);
  });
});
