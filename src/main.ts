import { Client, Events } from "@fluxerjs/core";
import type { Bot } from "./bot.ts";
import type { CommandEntry } from "./commands/command.ts";
import { help, ping } from "./commands/general.ts";
import { CommandRouter } from "./commands/router.ts";
import { ConfigError, loadConfig, readToken } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { emojiCommands } from "./emoji/commands.ts";
import { FluxerEmojiGuild } from "./emoji/fluxer.ts";
import { EMOJI_POLL_KIND, EmojiProposals } from "./emoji/proposals.ts";
import { FluxerGuildAccess } from "./permissions.ts";
import { attachPollEvents, FluxerPollTransport } from "./polls/fluxer.ts";
import { PollService } from "./polls/service.ts";

async function main() {
  const config = await loadConfig();
  const token = await readToken();
  const db = openDatabase(config.database);

  const client = await Client.fromDiscovery(config.instance);
  const access = new FluxerGuildAccess(client, config.guildId, config.adminRoleIds);
  const polls = new PollService(db, new FluxerPollTransport(client));

  const commands: CommandEntry[] = [ping, help];
  if (config.emoji) {
    const proposals = new EmojiProposals({
      db,
      polls,
      guild: new FluxerEmojiGuild(client, config.guildId),
      access,
      config: config.emoji,
      guildId: config.guildId,
    });
    polls.register(EMOJI_POLL_KIND, proposals);
    commands.push(emojiCommands(proposals, config.emoji));
  }

  const router = new CommandRouter(commands);
  const bot: Bot = { client, config, db, router, access, polls };

  client.on(Events.Ready, () => {
    console.info(`logged in as ${client.user?.username} on ${config.instance}`);
    // Catch up on votes cast while offline before deadlines are processed.
    void polls
      .reconcile()
      .catch((err) => console.error("poll reconcile failed:", err))
      .finally(() => polls.start());
  });
  client.on(Events.MessageCreate, (message) => {
    void router.handleMessage(bot, message);
  });
  attachPollEvents(client, polls);

  const shutdown = async (signal: string) => {
    console.info(`received ${signal}, shutting down`);
    polls.stop();
    await client.destroy();
    db.$client.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(token);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
