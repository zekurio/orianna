import type { Client } from "@fluxerjs/core";
import type { CommandRouter } from "./commands/router.ts";
import type { Config } from "./config.ts";
import type { DB } from "./db/index.ts";
import type { GuildAccess } from "./permissions/rules.ts";
import type { PollService } from "./polls/service.ts";

/** Shared dependencies handed to commands and features. */
export interface Bot {
  client: Client;
  /** Replaced when the config is reloaded, so read it when you need it. */
  config: Config;
  db: DB;
  router: CommandRouter;
  access: GuildAccess;
  polls: PollService;
}
