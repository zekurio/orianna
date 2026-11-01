import { Context } from "effect";

/**
 * The guild a piece of work is for. The bot serves every guild it's in, and
 * each guild's features, commands and web calls run with this set to it;
 * src/guilds.ts gives each guild its own services.
 */
export class CurrentGuild extends Context.Service<CurrentGuild, { readonly id: string }>()("orianna/CurrentGuild") {}
