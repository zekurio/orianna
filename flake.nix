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

      checks = forAllSystems (
        pkgs:
        let
          orianna = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          tests = pkgs.stdenvNoCC.mkDerivation {
            name = "orianna-tests";
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./src
                ./drizzle
              ];
            };
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            buildPhase = ''
              ln -s ${orianna.nodeModules} node_modules
              HOME=$TMPDIR bun test
            '';
            installPhase = "touch $out";
          };

          nixos = pkgs.testers.runNixOSTest (import ./nix/test.nix self);
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
