self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.orianna;
  format = pkgs.formats.json { };
  configFile = format.generate "orianna.json" cfg.settings;
  # The keys the bot applies on reload, as in reloadedConfig in src/config.ts.
  reloaded = [
    "prefix"
    "permissions"
  ];
in
{
  options.services.orianna = {
    enable = lib.mkEnableOption "Orianna, a bot for a self-hosted Fluxer instance";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "orianna.packages.\${system}.default";
      description = "The Orianna package to run.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.path;
      example = "/run/secrets/orianna-token";
      description = ''
        File containing the bot token. It is passed to the service with systemd's
        LoadCredential, so it can stay readable by root only (agenix, sops-nix, ...).
      '';
    };

    settings = lib.mkOption {
      description = ''
        Bot configuration, written to /etc/orianna/config.json. See
        docs/configuration.md for every key. Unknown keys are rejected when the bot
        starts. Changing only `prefix` or `permissions` reloads the bot;
        changing anything else restarts it.
      '';
      example = lib.literalExpression ''
        {
          instance = "https://chat.example.org";
          guildId = "1234567890";
          permissions.roles."2345678901" = [ "+*" ];
          pollsChannelId = "3456789012";
          emoji = { };
          sticker = { };
          polls = { };
        }
      '';
      type = lib.types.submodule {
        freeformType = format.type;
        options = {
          instance = lib.mkOption {
            type = lib.types.str;
            example = "https://chat.example.org";
            description = "Origin of the Fluxer instance; the bot reads /.well-known/fluxer from it.";
          };
          guildId = lib.mkOption {
            type = lib.types.str;
            description = "ID of the guild the bot serves.";
          };
          pollsChannelId = lib.mkOption {
            type = lib.types.str;
            description = "ID of the channel where emoji and sticker proposals are put to a vote.";
          };
          database = lib.mkOption {
            type = lib.types.str;
            default = "/var/lib/orianna/orianna.db";
            description = "Path of the SQLite database.";
          };
        };
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.etc."orianna/config.json".source = configFile;

    systemd.services.orianna = {
      description = "Orianna Fluxer bot";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment.ORIANNA_CONFIG = "/etc/orianna/config.json";
      reloadTriggers = [ configFile ];
      restartTriggers = [ (builtins.toJSON (removeAttrs cfg.settings reloaded)) ];

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
        LoadCredential = "token:${cfg.tokenFile}";
        DynamicUser = true;
        StateDirectory = "orianna";
        WorkingDirectory = "/var/lib/orianna";
        Restart = "on-failure";
        RestartSec = 10;

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        PrivateUsers = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
        # JavaScriptCore's JIT needs writable and executable memory.
        MemoryDenyWriteExecute = false;
      };
    };
  };
}
