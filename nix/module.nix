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

    clientSecretFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/orianna-client-secret";
      description = ''
        File containing the client secret of the bot's application, which the web
        interface needs to sign members in. Required when `settings.web` is set.
        It is passed to the service like `tokenFile`.
      '';
    };

    settings = lib.mkOption {
      description = ''
        Deployment configuration, written to /etc/orianna/config.json. See
        docs/configuration.md for every key. Unknown keys are rejected when the bot
        starts, and any change restarts it.

        Bot settings like `permissions`, `emoji` or `boards` live in the bot's
        database and are edited with `!settings`, not here.
      '';
      example = lib.literalExpression ''
        {
          instance = "https://chat.example.org";
          guildId = "1234567890";
          web = {
            publicUrl = "https://orianna.example.org";
            clientId = "1234567890";
          };
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
    assertions = [
      {
        assertion = cfg.settings ? web -> cfg.clientSecretFile != null;
        message = "services.orianna.clientSecretFile must be set for the web interface in services.orianna.settings.web.";
      }
    ];

    environment.etc."orianna/config.json".source = configFile;

    systemd.services.orianna = {
      description = "Orianna Fluxer bot";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment.ORIANNA_CONFIG = "/etc/orianna/config.json";
      restartTriggers = [ configFile ];

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        LoadCredential = [
          "token:${cfg.tokenFile}"
        ]
        ++ lib.optional (cfg.clientSecretFile != null) "client-secret:${cfg.clientSecretFile}";
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
