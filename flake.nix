{
  description = "vtxo.market backend services — indexer and introspector NixOS modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  };

  outputs = {nixpkgs, ...}: {
    nixosModules = {
      indexer = import ./nix/indexer.nix;
      introspector = import ./nix/introspector.nix;
      default = {
        imports = [
          ./nix/indexer.nix
          ./nix/introspector.nix
        ];
      };
    };
  };
}
