{ pkgs, ... }:

{
  packages = [ pkgs.sqlite ];

  languages.javascript = {
    enable = true;
    bun = {
      enable = true;
      install.enable = true;
    };
  };

  # The bot token comes from ORIANNA_TOKEN in .env, which bun loads automatically.
  env.ORIANNA_CONFIG = "./config.json";

  enterTest = ''
    bun run typecheck
  '';
}
