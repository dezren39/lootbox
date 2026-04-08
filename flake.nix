{
  description = "lootbox – Deno CLI with Hono server, MCP, and Vite UI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # ── helpers ──────────────────────────────────────────────────
        version = (builtins.fromJSON (builtins.readFile ./deno.json)).version;

        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            let
              baseName = builtins.baseNameOf path;
            in
            # exclude build artefacts, caches, and IDE dirs
            baseName != "node_modules"
            && baseName != ".git"
            && baseName != ".opencode"
            && baseName != ".lootbox"
            && baseName != "lootbox"; # compiled binary in repo root
        };

        # ── vendored chrome-devtools-mcp ─────────────────────────────
        #
        # The published npm package is a self-contained rollup bundle
        # (all deps are devDeps — zero runtime npm deps).  We just need
        # node + the tarball contents.
        chrome-devtools-mcp = pkgs.stdenv.mkDerivation rec {
          pname = "chrome-devtools-mcp";
          version = "0.21.0";

          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/${pname}/-/${pname}-${version}.tgz";
            hash = "sha256-KMHWSSctf6ihIT792yZeTqaYuHqmUanN2SJje5PI184=";
          };

          nativeBuildInputs = [ pkgs.makeWrapper ];

          unpackPhase = ''
            mkdir -p $TMPDIR/pkg
            tar xzf $src -C $TMPDIR/pkg --strip-components=1
          '';

          installPhase = ''
            mkdir -p $out/lib/chrome-devtools-mcp $out/bin

            cp -r $TMPDIR/pkg/build $out/lib/chrome-devtools-mcp/
            cp $TMPDIR/pkg/package.json $out/lib/chrome-devtools-mcp/

            # Wrapper script: runs the MCP server with node from the Nix store
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/chrome-devtools-mcp \
              --add-flags "$out/lib/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
          '';

          meta = with pkgs.lib; {
            description = "MCP server for Chrome DevTools (vendored)";
            homepage = "https://github.com/ChromeDevTools/chrome-devtools-mcp";
            license = licenses.asl20;
            mainProgram = "chrome-devtools-mcp";
          };
        };

        # ── package: compiled lootbox binary ─────────────────────────
        lootbox = pkgs.stdenv.mkDerivation {
          pname = "lootbox";
          inherit version src;

          nativeBuildInputs = [
            pkgs.deno
            pkgs.makeWrapper
          ];

          # Deno needs a writable home for its cache
          buildPhase = ''
            export DENO_DIR="$TMPDIR/deno"
            mkdir -p "$DENO_DIR"

            # Cache deps first (network allowed during build via FOD or --impure)
            deno install

            # Build the UI
            cd ui && deno install && deno run -A npm:vite build && cd ..

            # Compile the CLI binary
            deno compile --allow-all --include ui/dist -o lootbox src/lootbox-cli.ts
          '';

          # The compiled binary spawns `deno run` subprocesses at runtime
          # (worker_manager, execute_llm_script, execute_rpc) so deno must
          # be on PATH.
          installPhase = ''
            mkdir -p $out/bin
            cp lootbox $out/bin/.lootbox-unwrapped
            makeWrapper $out/bin/.lootbox-unwrapped $out/bin/lootbox \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.deno ]}
          '';

          meta = with pkgs.lib; {
            description = "lootbox CLI – Hono server, MCP, Vite UI";
            license = licenses.mit;
            mainProgram = "lootbox";
          };
        };

        # ── lootbox-full: lootbox + vendored chrome-devtools-mcp ────
        #
        # Single install gives you `lootbox` and `chrome-devtools-mcp`
        # on the same PATH.  lootbox can spawn the MCP server without
        # the user ever running `npm i -g` or `npx`.
        #
        # In lootbox.config.json, just use the binary name:
        #   { "server": { "mcpServers": { "chrome-devtools": {
        #       "command": "chrome-devtools-mcp",
        #       "args": ["--headless"]
        #   }}}}
        lootbox-full = pkgs.symlinkJoin {
          name = "lootbox-full-${version}";
          paths = [
            lootbox
            chrome-devtools-mcp
          ];

          meta = with pkgs.lib; {
            description = "lootbox CLI with vendored chrome-devtools-mcp";
            license = licenses.mit;
            mainProgram = "lootbox";
          };
        };

      in
      {
        # ── packages ───────────────────────────────────────────────
        packages = {
          default = lootbox;
          lootbox = lootbox;
          lootbox-full = lootbox-full;
          inherit chrome-devtools-mcp;
        };

        # ── apps ───────────────────────────────────────────────────
        apps.default = {
          type = "app";
          program = "${lootbox}/bin/lootbox";
        };

        # Run the chrome-devtools-mcp server standalone
        apps.chrome-devtools-mcp = {
          type = "app";
          program = "${chrome-devtools-mcp}/bin/chrome-devtools-mcp";
        };

        # Dev convenience: cache deps + compile in working tree
        apps.update = {
          type = "app";
          program = toString (
            pkgs.writeShellScript "lootbox-update" ''
              set -euo pipefail
              export PATH="${pkgs.deno}/bin:$PATH"
              deno install
              cd ui && deno install && cd ..
              deno task compile
            ''
          );
        };

        # Install the pre-built binary: nix run .#install -- [dest]
        # Copies to $1 if given, otherwise $PWD/lootbox
        apps.install = {
          type = "app";
          program = toString (
            pkgs.writeShellScript "lootbox-install" ''
              set -euo pipefail
              dest="''${1:-./lootbox}"
              cp -f "${lootbox}/bin/.lootbox-unwrapped" "$dest"
              chmod +x "$dest"
              echo "installed lootbox → $dest"
            ''
          );
        };

        # ── devShell ───────────────────────────────────────────────
        devShells.default = pkgs.mkShell {
          name = "lootbox-dev";

          packages = with pkgs; [
            deno
            nodejs_22 # for ui/vite tooling
          ];

          shellHook = ''
            echo "lootbox dev shell  (deno $(deno --version | head -1 | awk '{print $2}'))"
          '';
        };

        # ── formatter (nix fmt) ────────────────────────────────────
        formatter = pkgs.writeShellScriptBin "lootbox-fmt" ''
          set -euo pipefail
          export PATH="${pkgs.deno}/bin:$PATH"
          deno lint --fix "$@"
          deno fmt "$@"
        '';

        # ── checks (nix flake check) ──────────────────────────────
        checks = {
          # Run the test suite
          tests = pkgs.stdenv.mkDerivation {
            name = "lootbox-check-tests";
            inherit src;
            nativeBuildInputs = [ pkgs.deno ];
            buildPhase = ''
              export DENO_DIR="$TMPDIR/deno"
              mkdir -p "$DENO_DIR"
              deno test --allow-all test/
            '';
            installPhase = "mkdir -p $out && touch $out/ok";
          };

          # Formatting check (--check mode, no writes)
          formatting = pkgs.stdenv.mkDerivation {
            name = "lootbox-check-formatting";
            inherit src;
            nativeBuildInputs = [ pkgs.deno ];
            buildPhase = ''
              export DENO_DIR="$TMPDIR/deno"
              mkdir -p "$DENO_DIR"
              echo "Checking deno fmt..."
              deno fmt --check
              echo "Checking deno lint..."
              deno lint
            '';
            installPhase = "mkdir -p $out && touch $out/ok";
          };
        };
      }
    );
}
