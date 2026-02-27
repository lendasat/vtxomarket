import { encryptWithPassword, decryptWithPassword, isEncrypted } from "./wallet-crypto";

const DB_NAME = "vtxo-fun-wallet";
const STORE_NAME = "wallet";
const DB_VERSION = 1;
const MNEMONIC_KEY = "mnemonic";
const NOSTR_KEY_OVERRIDE = "nostr-key-override";
const PASSWORD_CHECK_KEY = "password-check"; // stores encrypted known value to verify password

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Store missing (DB exists but store was lost) — delete and re-create
        db.close();
        const delReq = indexedDB.deleteDatabase(DB_NAME);
        delReq.onsuccess = () => {
          const retry = indexedDB.open(DB_NAME, DB_VERSION);
          retry.onupgradeneeded = () => {
            retry.result.createObjectStore(STORE_NAME);
          };
          retry.onsuccess = () => resolve(retry.result);
          retry.onerror = () => reject(retry.error);
        };
        delReq.onerror = () => reject(delReq.error);
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveMnemonic(mnemonic: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(mnemonic, MNEMONIC_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMnemonic(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(MNEMONIC_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMnemonic(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(MNEMONIC_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveNostrKeyOverride(hexKey: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(hexKey, NOSTR_KEY_OVERRIDE);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getNostrKeyOverride(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(NOSTR_KEY_OVERRIDE);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAllWalletData(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(MNEMONIC_KEY);
    store.delete(NOSTR_KEY_OVERRIDE);
    store.delete(PASSWORD_CHECK_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -- Password-encrypted storage --

const PASSWORD_CHECK_VALUE = "vtxo-fun-password-ok";

/** Check if a wallet password has been set */
export async function hasPassword(): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(PASSWORD_CHECK_KEY);
    request.onsuccess = () => resolve(request.result != null);
    request.onerror = () => reject(request.error);
  });
}

/** Set up wallet encryption with a password. Encrypts existing mnemonic if present. */
export async function setupPassword(password: string): Promise<void> {
  // Store an encrypted known value so we can verify the password later
  const checkValue = await encryptWithPassword(PASSWORD_CHECK_VALUE, password);
  const db = await openDB();

  // If there's an existing plaintext mnemonic, encrypt it
  const existingMnemonic = await getMnemonic();
  if (existingMnemonic && !isEncrypted(existingMnemonic)) {
    const encryptedMnemonic = await encryptWithPassword(existingMnemonic, password);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(encryptedMnemonic, MNEMONIC_KEY);
      store.put(checkValue, PASSWORD_CHECK_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(checkValue, PASSWORD_CHECK_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Also encrypt the nostr key override if present
  const nostrOverride = await getNostrKeyOverride();
  if (nostrOverride && !isEncrypted(nostrOverride)) {
    const encrypted = await encryptWithPassword(nostrOverride, password);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(encrypted, NOSTR_KEY_OVERRIDE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** Verify a password against the stored check value */
export async function verifyPassword(password: string): Promise<boolean> {
  const db = await openDB();
  const checkValue = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(PASSWORD_CHECK_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });

  if (!checkValue) return false;

  try {
    const decrypted = await decryptWithPassword(checkValue, password);
    return decrypted === PASSWORD_CHECK_VALUE;
  } catch {
    return false; // wrong password
  }
}

/**
 * Save mnemonic with optional encryption.
 * If password is provided, encrypts before storing.
 */
export async function saveMnemonicEncrypted(mnemonic: string, password: string): Promise<void> {
  const encrypted = await encryptWithPassword(mnemonic, password);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(encrypted, MNEMONIC_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get mnemonic, decrypting if encrypted.
 * If data is encrypted and no password provided, returns null.
 * If data is plaintext, returns as-is (backward compatible).
 */
export async function getMnemonicDecrypted(password?: string): Promise<string | null> {
  const raw = await getMnemonic();
  if (!raw) return null;

  if (isEncrypted(raw)) {
    if (!password) return null; // needs password
    try {
      return await decryptWithPassword(raw, password);
    } catch {
      return null; // wrong password
    }
  }

  // Plaintext (pre-encryption wallet) — return as-is
  return raw;
}

/**
 * Check if the stored mnemonic is encrypted.
 */
export async function isMnemonicEncrypted(): Promise<boolean> {
  const raw = await getMnemonic();
  if (!raw) return false;
  return isEncrypted(raw);
}

/**
 * Get nostr key override, decrypting if encrypted.
 */
export async function getNostrKeyOverrideDecrypted(password?: string): Promise<string | null> {
  const raw = await getNostrKeyOverride();
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
