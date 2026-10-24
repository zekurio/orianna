{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
}:

let
  fs = lib.fileset;
  version = (lib.importJSON ../package.json).version;

  # Production dependencies from bun.lock. Update `outputHash` whenever the
  # lockfile changes: set it to lib.fakeHash, build, and copy the hash from the error.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "orianna-node-modules";
    inherit version;

    src = fs.toSource {
      root = ../.;
      fileset = fs.unions [
        ../package.json
        ../bun.lock
      ];
    };

    nativeBuildInputs = [ bun ];

    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --production --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      cp -r node_modules $out
      runHook postInstall
    '';
    dontFixup = true;

    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-jdrIq/Gbp1I/fcVN5e5aejbvbNOayvBBKoLue+lgmkM=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "orianna";
  inherit version;

  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      ../package.json
      ../src
      ../drizzle
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/orianna
    cp -r package.json src drizzle $out/lib/orianna/
    ln -s ${nodeModules} $out/lib/orianna/node_modules

    # Bun runs the TypeScript directly. Its transpiler cache would try to write
    # under $HOME, which a DynamicUser service doesn't have.
    makeWrapper ${lib.getExe bun} $out/bin/orianna \
      --add-flags "$out/lib/orianna/src/main.ts" \
      --set-default BUN_RUNTIME_TRANSPILER_CACHE_PATH 0
    runHook postInstall
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "A bot for a self-hosted Fluxer instance";
    mainProgram = "orianna";
    platforms = lib.platforms.linux;
  };
}
