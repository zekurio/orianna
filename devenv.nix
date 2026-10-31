{ pkgs, ... }:

{
  # The bot processes emoji and sticker images with ImageMagick's `magick`.
  packages = [
    pkgs.sqlite
    pkgs.imagemagick
  ];

  languages.javascript = {
    enable = true;
    bun = {
      enable = true;
      install.enable = true;
    };
  };

  # The bot token comes from FLUXER_BOT_TOKEN in .env, which bun loads automatically.
  # devenv's dotenv integration stays off so the token isn't exported to the shell.
  env.ORIANNA_CONFIG = "./config.json";
  dotenv.disableHint = true;
}
