{
  description = "Orianna, a bot for a self-hosted Fluxer instance";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        orianna = pkgs.callPackage ./nix/package.nix { };
        default = orianna;
      });

      nixosModules = rec {
        orianna = import ./nix/module.nix self;
        default = orianna;
      };

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
