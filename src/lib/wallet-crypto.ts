import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic as bip39Validate } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

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
