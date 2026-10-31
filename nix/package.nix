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
        # Keeps bun-plugin-tailwind's `bun` peer, every platform's Bun, out.
        ../bunfig.toml
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
    outputHash = "sha256-zR6Ekk7sTndXKQE+R1jn/uEjY4fxTmSdjp5qVykZiag=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "orianna";
  inherit version;

  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      ../package.json
      ../bunfig.toml
      ../tsconfig.json
      ../scripts
      ../src
      ../drizzle
    ];
  };

  nativeBuildInputs = [
    bun
    makeWrapper
  ];

  # `bun run build` compiles the bot, the web interface and the migrations into
  # one executable, with the Bun runtime inside. scripts/build.ts runs Tailwind
  # over the web interface's styles on the way.
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    # A copy, not a symlink: the sourcemap in the executable names each package
    # by where Bun found it, and a store path there would keep node_modules
    # in the closure.
    cp -r ${nodeModules}/node_modules node_modules
    export HOME=$TMPDIR
    bun run build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    # Emoji and sticker images are processed with ImageMagick's `magick`.
    install -Dm755 dist/orianna $out/bin/orianna
    wrapProgram $out/bin/orianna --prefix PATH : ${lib.makeBinPath [ imagemagick ]}
    runHook postInstall
  '';
  # Bun keeps the program in the executable's `.bun` section. Stripping drops
  # it, and what's left is the plain Bun CLI.
  dontStrip = true;

  passthru = { inherit nodeModules; };

  meta = {
    description = "A bot for a self-hosted Fluxer instance";
    mainProgram = "orianna";
    platforms = lib.platforms.linux;
  };
}
