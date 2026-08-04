# NOTE:
# This is quite bad way to do this,
# but until Nix has a proper way to package
# node projects it works.
# See https://github.com/NixOS/nixpkgs/issues/255890
{
  description = "A formatter for the Kulala language";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  };

  outputs = inputs @ {
    self,
    flake-parts,
    ...
  }:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];

      perSystem = {pkgs, ...}: let
        # Create a simple wrapper script that uses npx to run kulala-fmt
        kulala-fmt = pkgs.writeShellApplication {
          name = "kulala-fmt";
          runtimeInputs = [pkgs.nodejs];
          text = ''
            # Run kulala-fmt using npx
            exec npx github:mistweaverco/kulala-fmt "$@"
          '';
        };
      in {
        packages = {
          default = kulala-fmt;
          kulala-fmt = kulala-fmt;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs
            pkgs.nodePackages.pnpm
          ];

          shellHook = ''
            echo "Kulala formatter development environment"
            echo "Run 'pnpm install' to install dependencies"
            echo "Run 'pnpm run build' to build the project"
            echo "Run 'node ./dist/postinstall.cjs' to download kulala-core"
          '';
        };
      };
    };
}
