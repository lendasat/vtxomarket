/**
 * Wallet storage module — Dexie-based IndexedDB storage.
 *
 * Provides persistent storage for mnemonic, keys, and password data.
 *
 * Schema history:
 *   v1 (legacy): Raw IndexedDB "vtxo-fun-wallet" with key-value store
 *   v2 (current): Dexie "vtxo-market-v2" with typed wallet table
 */

import Dexie, { type EntityTable } from "dexie";
import { encryptWithPassword, decryptWithPassword, isEncrypted } from "./wallet-crypto";

// ── Database ────────────────────────────────────────────────────────────────

const DB_NAME = "vtxo-market-v2";
const DB_VERSION = 1;

// Legacy (v1) database constants for migration
const V1_DB_NAME = "vtxo-fun-wallet";
const V1_STORE_NAME = "wallet";

interface WalletRecord {
  key: string;
  value: string;
}

class VtxoMarketDatabase extends Dexie {
  wallet!: EntityTable<WalletRecord, "key">;

  constructor() {
    super(DB_NAME);
    this.version(DB_VERSION).stores({
      wallet: "key",
    });
  }
}

// Singleton database instance
let dbInstance: VtxoMarketDatabase | null = null;

function getDatabase(): VtxoMarketDatabase {
  if (!dbInstance) {
    dbInstance = new VtxoMarketDatabase();
  }
  return dbInstance;
}

// ── Storage keys ────────────────────────────────────────────────────────────

const MNEMONIC_KEY = "mnemonic";
const NOSTR_KEY_OVERRIDE = "nostr-key-override";
const PASSWORD_CHECK_KEY = "password-check";
const PASSWORD_CHECK_VALUE = "vtxo-market-password-ok";

// ── WalletStorage interface ─────────────────────────────────────────────────

export interface WalletStorage {
  getMnemonic(): Promise<string | null>;
  setMnemonic(mnemonic: string): Promise<void>;
  deleteMnemonic(): Promise<void>;
  getNostrKeyOverride(): Promise<string | null>;
  setNostrKeyOverride(hexKey: string): Promise<void>;
  hasPassword(): Promise<boolean>;
  setupPassword(password: string): Promise<void>;
  verifyPassword(password: string): Promise<boolean>;
  setMnemonicEncrypted(mnemonic: string, password: string): Promise<void>;
  getMnemonicDecrypted(password?: string): Promise<string | null>;
  isMnemonicEncrypted(): Promise<boolean>;
  getNostrKeyOverrideDecrypted(password?: string): Promise<string | null>;
  clear(): Promise<void>;
}

// ── IdbWalletStorage ────────────────────────────────────────────────────────

export class IdbWalletStorage implements WalletStorage {
  readonly #db: VtxoMarketDatabase;
  #migratedFromLegacy = false;

  constructor() {
    this.#db = getDatabase();
  }

  /**
   * Whether a legacy (v1) wallet was migrated during this session.
   * When true, the old "vtxo-fun-wallet" IndexedDB can be safely deleted.
   */
  get migratedFromLegacy(): boolean {
    return this.#migratedFromLegacy;
  }

  async getMnemonic(): Promise<string | null> {
    const record = await this.#db.wallet.get(MNEMONIC_KEY);
    if (record?.value) {
      return record.value;
    }

    // No mnemonic in v2 — try migrating from legacy (v1) raw IndexedDB
    const legacy = await readLegacyWallet();
    if (!legacy) return null;

    // Persist to v2 so migration only happens once
    if (legacy.mnemonic) {
      await this.setMnemonic(legacy.mnemonic);
    }
    if (legacy.nostrKeyOverride) {
      await this.setNostrKeyOverride(legacy.nostrKeyOverride);
    }
    if (legacy.passwordCheck) {
      await this.#db.wallet.put({ key: PASSWORD_CHECK_KEY, value: legacy.passwordCheck });
    }
    this.#migratedFromLegacy = true;

    return legacy.mnemonic;
  }

  async setMnemonic(mnemonic: string): Promise<void> {
    await this.#db.wallet.put({ key: MNEMONIC_KEY, value: mnemonic });
  }

  async deleteMnemonic(): Promise<void> {
    await this.#db.wallet.delete(MNEMONIC_KEY);
  }

  async getNostrKeyOverride(): Promise<string | null> {
    const record = await this.#db.wallet.get(NOSTR_KEY_OVERRIDE);
    return record?.value ?? null;
  }

  async setNostrKeyOverride(hexKey: string): Promise<void> {
    await this.#db.wallet.put({ key: NOSTR_KEY_OVERRIDE, value: hexKey });
  }

  // ── Password encryption ─────────────────────────────────────────────────

  async hasPassword(): Promise<boolean> {
    const record = await this.#db.wallet.get(PASSWORD_CHECK_KEY);
    return record?.value != null;
  }

  async setupPassword(password: string): Promise<void> {
    const checkValue = await encryptWithPassword(PASSWORD_CHECK_VALUE, password);

    // If there's an existing plaintext mnemonic, encrypt it
    const existingMnemonic = await this.getMnemonic();
    if (existingMnemonic && !isEncrypted(existingMnemonic)) {
      const encryptedMnemonic = await encryptWithPassword(existingMnemonic, password);
      await this.#db.transaction("rw", this.#db.wallet, async () => {
        await this.#db.wallet.put({ key: MNEMONIC_KEY, value: encryptedMnemonic });
        await this.#db.wallet.put({ key: PASSWORD_CHECK_KEY, value: checkValue });
      });
    } else {
      await this.#db.wallet.put({ key: PASSWORD_CHECK_KEY, value: checkValue });
    }

    // Also encrypt the nostr key override if present
    const nostrOverride = await this.getNostrKeyOverride();
    if (nostrOverride && !isEncrypted(nostrOverride)) {
      const encrypted = await encryptWithPassword(nostrOverride, password);
      await this.#db.wallet.put({ key: NOSTR_KEY_OVERRIDE, value: encrypted });
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    const record = await this.#db.wallet.get(PASSWORD_CHECK_KEY);
    if (!record?.value) return false;

    try {
      const decrypted = await decryptWithPassword(record.value, password);
      return decrypted === PASSWORD_CHECK_VALUE;
    } catch {
      return false;
    }
  }

  async setMnemonicEncrypted(mnemonic: string, password: string): Promise<void> {
    const encrypted = await encryptWithPassword(mnemonic, password);
    await this.#db.wallet.put({ key: MNEMONIC_KEY, value: encrypted });
  }

  async getMnemonicDecrypted(password?: string): Promise<string | null> {
    const raw = await this.getMnemonic();
    if (!raw) return null;

    if (isEncrypted(raw)) {
      if (!password) return null;
      try {
        return await decryptWithPassword(raw, password);
      } catch {
        return null;
      }
    }

    // Plaintext (pre-encryption wallet) — return as-is
    return raw;
  }

  async isMnemonicEncrypted(): Promise<boolean> {
    const raw = await this.getMnemonic();
    if (!raw) return false;
    return isEncrypted(raw);
  }

  async getNostrKeyOverrideDecrypted(password?: string): Promise<string | null> {
    const raw = await this.getNostrKeyOverride();
    if (!raw) return null;

    if (isEncrypted(raw)) {
      if (!password) return null;
      try {
        return await decryptWithPassword(raw, password);
      } catch {
        return null;
      }
    }

    return raw;
  }

  async clear(): Promise<void> {
    await this.#db.wallet.clear();
    // Also delete legacy v1 database to prevent re-migration on next getMnemonic()
    if (typeof indexedDB !== "undefined") {
      indexedDB.deleteDatabase(V1_DB_NAME);
    }
  }
}

// ── Legacy v1 migration ─────────────────────────────────────────────────────

interface LegacyWalletData {
  mnemonic: string | null;
  nostrKeyOverride: string | null;
  passwordCheck: string | null;
}

/**
 * Read wallet data from the legacy v1 raw IndexedDB database ("vtxo-fun-wallet").
 *
 * The v1 database used a plain object store with string keys:
 *   "mnemonic", "nostr-key-override", "password-check"
 *
 * Returns null if the v1 database doesn't exist or has no wallet data.
 */
function readLegacyWallet(): Promise<LegacyWalletData | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    const request = indexedDB.open(V1_DB_NAME);

    // If onupgradeneeded fires, the database didn't exist — abort to
    // prevent creating an empty v1 database.
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };

    request.onerror = () => {
      resolve(null);
    };

    request.onsuccess = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(V1_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }

      try {
        const tx = db.transaction(V1_STORE_NAME, "readonly");
        const store = tx.objectStore(V1_STORE_NAME);
        const results: Record<string, string | null> = {};
        const keys = ["mnemonic", "nostr-key-override", "password-check"];
        let remaining = keys.length;

        keys.forEach((key) => {
          const getReq = store.get(key);
          getReq.onsuccess = () => {
            results[key] = getReq.result ?? null;
            remaining--;
            if (remaining === 0) {
              db.close();
              if (!results["mnemonic"] && !results["nostr-key-override"]) {
                resolve(null);
              } else {
                resolve({
                  mnemonic: results["mnemonic"],
                  nostrKeyOverride: results["nostr-key-override"],
                  passwordCheck: results["password-check"],
                });
              }
            }
          };
          getReq.onerror = () => {
            remaining--;
            if (remaining === 0) {
              db.close();
              resolve(null);
            }
          };
        });
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

// ── Singleton + standalone function exports ─────────────────────────────────
// Backward-compatible standalone functions that delegate to a singleton instance.
// Consumers can gradually migrate to using `walletStorage` directly.

let _storage: IdbWalletStorage | null = null;

function getStorage(): IdbWalletStorage {
  if (!_storage) {
    _storage = new IdbWalletStorage();
  }
  return _storage;
}

/** Singleton storage instance. Prefer using this over standalone functions. */
export const walletStorage = getStorage;

// Standalone function exports (backward compat with existing consumers)
export const getMnemonic = () => getStorage().getMnemonic();
export const saveMnemonic = (m: string) => getStorage().setMnemonic(m);
export const deleteMnemonic = () => getStorage().deleteMnemonic();
export const saveNostrKeyOverride = (k: string) => getStorage().setNostrKeyOverride(k);
export const getNostrKeyOverride = () => getStorage().getNostrKeyOverride();
export const deleteAllWalletData = () => getStorage().clear();
export const hasPassword = () => getStorage().hasPassword();
export const setupPassword = (p: string) => getStorage().setupPassword(p);
export const verifyPassword = (p: string) => getStorage().verifyPassword(p);
export const saveMnemonicEncrypted = (m: string, p: string) =>
  getStorage().setMnemonicEncrypted(m, p);
export const getMnemonicDecrypted = (p?: string) => getStorage().getMnemonicDecrypted(p);
export const isMnemonicEncrypted = () => getStorage().isMnemonicEncrypted();
export const getNostrKeyOverrideDecrypted = (p?: string) =>
  getStorage().getNostrKeyOverrideDecrypted(p);
