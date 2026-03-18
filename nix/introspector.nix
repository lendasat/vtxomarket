{
  config,
  lib,
  ...
}: let
  cfg = config.services.vtxomarket-introspector;
  settingsType = lib.types.submodule {
    options = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 7073;
        description = "gRPC + REST gateway port.";
      };

      noTls = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Disable TLS (use true when behind a reverse proxy that terminates TLS).";
      };

      logLevel = lib.mkOption {
        type = lib.types.enum [0 1 2 3 4 5 6];
        default = 4;
        description = "Log verbosity (0=panic, 1=fatal, 2=error, 3=warn, 4=info, 5=debug, 6=trace).";
      };

      dataDir = lib.mkOption {
        type = lib.types.str;
        default = "/app/data";
        description = "Data directory inside the container.";
      };
    };
  };
in {
  options.services.vtxomarket-introspector = {
    enable = lib.mkEnableOption "vtxo.market introspector service";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/arklabshq/introspector:latest";
      description = "OCI image reference for the introspector.";
    };

    secretKeyFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path to a file containing the hex-encoded secret key (32 bytes).
        Typically a sops-nix secret path. The file content is read at
        container start and passed as INTROSPECTOR_SECRET_KEY.
      '';
    };

    settings = lib.mkOption {
      type = settingsType;
      description = "Introspector configuration.";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.oci-containers.containers.vtxomarket-introspector = {
      image = cfg.image;
      ports = ["${toString cfg.settings.port}:${toString cfg.settings.port}"];
      volumes = [
        "vtxomarket-introspector-data:${cfg.settings.dataDir}"
        "${cfg.secretKeyFile}:/run/secrets/introspector-secret-key:ro"
      ];
      environment = {
        INTROSPECTOR_NO_TLS = lib.boolToString cfg.settings.noTls;
        INTROSPECTOR_PORT = toString cfg.settings.port;
        INTROSPECTOR_LOG_LEVEL = toString cfg.settings.logLevel;
        INTROSPECTOR_DATADIR = cfg.settings.dataDir;
      };
      # Read the secret key from the mounted file at startup
      entrypoint = "/bin/sh";
      cmd = [
        "-c"
        "export INTROSPECTOR_SECRET_KEY=$(cat /run/secrets/introspector-secret-key) && exec introspector"
      ];
    };
  };
}
