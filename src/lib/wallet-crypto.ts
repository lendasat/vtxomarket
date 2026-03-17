import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { hex, bech32, base64 } from "@scure/base";

// Arkade key derivation path (same as arkade-king-game)
const ARK_DERIVATION_PATH = "m/44'/1237'/0'/0/0";

// Nostr key derivation path (same as lendamobile)
const NOSTR_DERIVATION_PATH = "m/44/0/0/0/0";

export function generateMnemonic(): string {
  return bip39Generate(wordlist, 128); // 12 words
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic, wordlist);
}

export function mnemonicToArkPrivateKeyHex(mnemonic: string): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(ARK_DERIVATION_PATH);
  if (!child.privateKey) throw new Error("Failed to derive Ark private key");
  return hex.encode(child.privateKey);
}

export function mnemonicToNostrPrivateKeyHex(mnemonic: string): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(NOSTR_DERIVATION_PATH);
  if (!child.privateKey) throw new Error("Failed to derive Nostr private key");
  return hex.encode(child.privateKey);
}

export function decodeNsec(nsec: string): string {
  const trimmed = nsec.trim().toLowerCase();
  if (!trimmed.startsWith("nsec1")) {
    throw new Error("Invalid nsec: must start with nsec1");
  }
  const decoded = bech32.decode(trimmed as `${string}1${string}`, 1500);
  if (decoded.prefix !== "nsec") {
    throw new Error("Invalid nsec prefix");
  }
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 32) {
    throw new Error("Invalid nsec: key must be 32 bytes");
  }
  return hex.encode(bytes);
}

// -- AES-GCM encryption for wallet data at rest --
// Matches Arkade wallet: PBKDF2 (100k iterations, SHA-256) + AES-GCM

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ENCRYPTED_PREFIX = "enc:"; // prefix to distinguish encrypted vs plaintext data

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a plaintext string with a password using AES-GCM + PBKDF2.
 * Returns a prefixed base64 string: "enc:<salt>:<iv>:<ciphertext>"
 */
export async function encryptWithPassword(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  const saltB64 = base64.encode(salt);
  const ivB64 = base64.encode(iv);
  const ctB64 = base64.encode(new Uint8Array(ciphertext));

  return `${ENCRYPTED_PREFIX}${saltB64}:${ivB64}:${ctB64}`;
}

/**
 * Decrypt an encrypted string produced by encryptWithPassword.
 * Throws if the password is wrong or data is corrupted.
 */
export async function decryptWithPassword(encrypted: string, password: string): Promise<string> {
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error("Data is not encrypted");
  }

  const parts = encrypted.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted data format");

  const salt = base64.decode(parts[0]);
  const iv = base64.decode(parts[1]);
  const ciphertext = base64.decode(parts[2]);

  const key = await deriveKey(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );

  return new TextDecoder().decode(plaintext);
}

/** Check if a stored value is encrypted (has the enc: prefix) */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}
