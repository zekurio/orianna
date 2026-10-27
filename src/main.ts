import { Client, Events } from "@fluxerjs/core";
import type { Bot } from "./bot.ts";
import type { CommandEntry } from "./commands/command.ts";
import { help, ping } from "./commands/general.ts";
import { CommandRouter } from "./commands/router.ts";
import { ConfigError, loadConfig, readToken } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { proposalCommands } from "./expressions/commands.ts";
import { FluxerExpressionGuild } from "./expressions/fluxer.ts";
import { EMOJI, ExpressionProposals, STICKER } from "./expressions/proposals.ts";
import { FluxerGuildAccess } from "./permissions.ts";
import { pollCommands } from "./polls/commands.ts";
import { COMMUNITY_POLL, CommunityPolls } from "./polls/community.ts";
import { attachPollMessageDeletes, FluxerPollTransport } from "./polls/fluxer.ts";
import { PollService } from "./polls/service.ts";
import { attachReactions } from "./reactions.ts";
import { attachRoleMenuEvents, FluxerRoleGuild } from "./roles/fluxer.ts";
import { RoleMenus } from "./roles/menus.ts";

async function main() {
  const config = await loadConfig();
  const token = await readToken();
  const db = openDatabase(config.database);

  const client = await Client.fromDiscovery(config.instance);
  const access = new FluxerGuildAccess(client, config.guildId, config.adminRoleIds);
  const pollTransport = new FluxerPollTransport(client, config.guildId);
  const polls = new PollService(db, pollTransport);

  const commands: CommandEntry[] = [ping, help];
  const guild = new FluxerExpressionGuild(client, config.guildId);
  for (const [kind, section] of [
    [EMOJI, config.emoji],
    [STICKER, config.sticker],
  ] as const) {
    if (!section) continue;
    const proposals = new ExpressionProposals(kind, {
      db,
      polls,
      guild,
      access,
      config: section,
      guildId: config.guildId,
      channelId: config.pollsChannelId,
    });
    polls.register(kind.pollKind, proposals);
    commands.push(proposalCommands(proposals, section, config.pollsChannelId));
  }
  let community: CommunityPolls | undefined;
  if (config.polls) {
    community = new CommunityPolls({
      db,
      polls,
      chat: pollTransport,
      access,
      config: config.polls,
      guildId: config.guildId,
    });
    polls.register(COMMUNITY_POLL, community);
    commands.push(...pollCommands(community));
  }

  const router = new CommandRouter(commands);
  const bot: Bot = { client, config, db, router, access, polls };
  // Built even without a `roleMenus` section, so removing it takes the menus down.
  const roleMenus = new RoleMenus(db, new FluxerRoleGuild(client, config.guildId), config.roleMenus);

  client.on(Events.Ready, () => {
    console.info(`logged in as ${client.user?.username} on ${config.instance}`);
    // Catch up on votes and 🛑 reactions from while offline before deadlines are processed.
    void polls
      .reconcile()
      .then(() => community?.reconcile())
      .catch((err) => console.error("poll reconcile failed:", err))
      .finally(() => polls.start());
    void roleMenus.sync();
  });
  client.on(Events.MessageCreate, (message) => {
    void router.handleMessage(bot, message);
  });
  attachReactions(client, polls, "poll");
  if (community) attachPollMessageDeletes(client, community);
  attachRoleMenuEvents(client, roleMenus, config.guildId);

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
