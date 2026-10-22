self:
{ pkgs, ... }:

# Boots the service against an instance that doesn't exist. The bot can't log
# in, but this proves the config, the token credential, the hardening and the
# database migrations all work under systemd.
{
  name = "orianna";

  nodes.machine = {
    imports = [ self.nixosModules.default ];
    environment.systemPackages = [ pkgs.sqlite ];

    services.orianna = {
      enable = true;
      tokenFile = pkgs.writeText "orianna-token" "not-a-real-token";
      settings = {
        instance = "http://127.0.0.1:9";
        guildId = "1";
        emoji.channelId = "2";
      };
    };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.wait_until_succeeds("journalctl -u orianna | grep -q 'Unable to connect'", timeout=120)
    tables = machine.succeed("sqlite3 /var/lib/orianna/orianna.db .tables")
    for table in ["polls", "votes", "emoji_proposals"]:
        assert table in tables, f"missing table {table}: {tables}"
  '';
}
