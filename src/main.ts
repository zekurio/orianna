import { Client, Events } from "@fluxerjs/core";
import type { Bot } from "./bot.ts";
import type { CommandEntry } from "./commands/command.ts";
import { help, ping } from "./commands/general.ts";
import { CommandRouter } from "./commands/router.ts";
import { ConfigError, loadConfig, readToken, reloadedConfig } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { proposalCommands } from "./expressions/commands.ts";
import { FluxerExpressionGuild } from "./expressions/fluxer.ts";
import { checkImageMagick } from "./expressions/process.ts";
import { EMOJI, ExpressionProposals, STICKER } from "./expressions/proposals.ts";
import { perms } from "./permissions/commands.ts";
import { FluxerGuildAccess } from "./permissions/fluxer.ts";
import { pollCommands } from "./polls/commands.ts";
import { COMMUNITY_POLL, CommunityPolls } from "./polls/community.ts";
import { attachPollMessageDeletes, FluxerPollTransport } from "./polls/fluxer.ts";
import { PollService } from "./polls/service.ts";
import { attachReactions } from "./reactions.ts";
import { attachRoleMenuEvents, FluxerRoleGuild } from "./roles/fluxer.ts";
import { RoleMenus } from "./roles/menus.ts";

async function main() {
  // Without a handler SIGHUP would end the process, and systemd doesn't restart
  // a service that SIGHUP ended. Reloads wait for the first login, then run in turn.
  const ready = Promise.withResolvers<void>();
  let reloads = ready.promise;
  process.on("SIGHUP", () => {
    reloads = reloads.then(reload).catch((err) => {
      const why = err instanceof ConfigError ? err.message : err;
      console.error("config not reloaded, keeping the old one:", why);
    });
  });

  const config = await loadConfig();
  const token = await readToken();
  const db = openDatabase(config.database);

  const client = await Client.fromDiscovery(config.instance);
  const access = new FluxerGuildAccess(client, config.guildId, () => bot.config.permissions);
  const pollTransport = new FluxerPollTransport(client, config.guildId);
  const polls = new PollService(db, pollTransport);

  const commands: CommandEntry[] = [ping, help, perms];
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
    commands.push(proposalCommands(proposals, config.pollsChannelId));
  }
  if (config.emoji || config.sticker) {
    // Polls and role menus work without ImageMagick, so this only warns.
    void checkImageMagick().then((problems) => {
      for (const problem of problems) {
        console.error(`emoji and sticker images won't work: ${problem}`);
      }
    });
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
    warnUnknownRoles(access);
    ready.resolve();
  });
  client.on(Events.MessageCreate, (message) => {
    void router.handleMessage(bot, message);
  });
  attachReactions(client, polls, "poll");
  if (community) attachPollMessageDeletes(client, community);
  attachRoleMenuEvents(client, roleMenus, config.guildId);

  async function reload() {
    const next = reloadedConfig(bot.config, await loadConfig());
    bot.config = next.config;
    console.info("config reloaded");
    if (next.needRestart.length > 0) {
      console.warn(`restart to apply the changes to ${next.needRestart.join(", ")}`);
    }
    warnUnknownRoles(access);
  }

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

function warnUnknownRoles(access: FluxerGuildAccess) {
  void access
    .unknownRoles()
    .then((ids) => {
      for (const id of ids) {
        console.warn(`permissions.roles: there is no role ${id}, so its rules do nothing`);
      }
    })
    .catch((err) => console.error("checking permission roles failed:", err));
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
