{
  lib,
  stdenvNoCC,
  bun,
  imagemagick,
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
    # Bun resolves a package's imports from its real path, past the symlink
    # into the package. The output has to end in node_modules, or packages
    # can't find each other and Bun tries to install them at runtime.
    installPhase = ''
      runHook preInstall
      mkdir $out
      cp -r node_modules $out/node_modules
      runHook postInstall
    '';
    dontFixup = true;

    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-LCCXDXlsFtGeAhvCilRGp8X01P0oTrTH/V8t437+wnQ=";
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
    ln -s ${nodeModules}/node_modules $out/lib/orianna/node_modules

    # Bun runs the TypeScript directly. Its transpiler cache would try to write
    # under $HOME, which a DynamicUser service doesn't have. Emoji and sticker
    # images are processed with ImageMagick's `magick`.
    makeWrapper ${lib.getExe bun} $out/bin/orianna \
      --add-flags "$out/lib/orianna/src/main.ts" \
      --set-default BUN_RUNTIME_TRANSPILER_CACHE_PATH 0 \
      --prefix PATH : ${lib.makeBinPath [ imagemagick ]}
    runHook postInstall
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "A bot for a self-hosted Fluxer instance";
    mainProgram = "orianna";
    platforms = lib.platforms.linux;
  };
}
