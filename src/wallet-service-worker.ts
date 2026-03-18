import {
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
  MessageBus,
  WalletMessageHandler,
} from "@arkade-os/sdk";

const walletRepository = new IndexedDBWalletRepository();
const contractRepository = new IndexedDBContractRepository();

// Allow the page to force activation of a newly installed worker.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil((self as unknown as ServiceWorkerGlobalScope).skipWaiting());
  }
});

const worker = new MessageBus(walletRepository, contractRepository, {
  messageHandlers: [new WalletMessageHandler()],
  tickIntervalMs: 5000,
});
worker.start().catch(console.error);

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
