{
  config,
  lib,
  ...
}: let
  cfg = config.services.vtxomarket-indexer;
  settingsType = lib.types.submodule {
    options = {
      arkServerUrl = lib.mkOption {
        type = lib.types.str;
        description = "URL of the Ark server to index (e.g. https://mutinynet.arkade.sh).";
      };

      network = lib.mkOption {
        type = lib.types.str;
        description = "Human-readable network label (e.g. mutinynet, mainnet).";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 3001;
        description = "HTTP port the indexer listens on.";
      };

      logLevel = lib.mkOption {
        type = lib.types.enum ["debug" "info" "warn" "error"];
        default = "info";
        description = "Log verbosity.";
      };

      databasePath = lib.mkOption {
        type = lib.types.str;
        default = "/var/lib/vtxomarket-indexer/indexer.db";
        description = "Path to the SQLite database file inside the container.";
      };

      sseReconnectDelayMs = lib.mkOption {
        type = lib.types.int;
        default = 3000;
        description = "Delay in ms before reconnecting to the Ark SSE stream.";
      };

      outpointBatchSize = lib.mkOption {
        type = lib.types.int;
        default = 50;
        description = "Number of outpoints to fetch per batch from the Ark server.";
      };

      corsOrigins = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "Allowed CORS origins. Empty list disables the CORS_ORIGINS env var.";
      };

      rateLimitMax = lib.mkOption {
        type = lib.types.int;
        default = 60;
        description = "Max requests per IP per minute.";
      };
    };
  };
in {
  options.services.vtxomarket-indexer = {
    enable = lib.mkEnableOption "vtxo.market indexer service";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/lendasat/vtxomarket/indexer:latest";
      description = "OCI image reference for the indexer.";
    };

    settings = lib.mkOption {
      type = settingsType;
      description = "Indexer configuration.";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.oci-containers.containers.vtxomarket-indexer = {
      image = cfg.image;
      ports = ["${toString cfg.settings.port}:${toString cfg.settings.port}"];
      volumes = [
        "vtxomarket-indexer-data:/app/data"
      ];
      environment = {
        ARK_SERVER_URL = cfg.settings.arkServerUrl;
        NETWORK = cfg.settings.network;
        PORT = toString cfg.settings.port;
        LOG_LEVEL = cfg.settings.logLevel;
        DATABASE_PATH = cfg.settings.databasePath;
        SSE_RECONNECT_DELAY_MS = toString cfg.settings.sseReconnectDelayMs;
        OUTPOINT_BATCH_SIZE = toString cfg.settings.outpointBatchSize;
        RATE_LIMIT_MAX = toString cfg.settings.rateLimitMax;
      } // lib.optionalAttrs (cfg.settings.corsOrigins != []) {
        CORS_ORIGINS = lib.concatStringsSep "," cfg.settings.corsOrigins;
      };
    };
  };
}
