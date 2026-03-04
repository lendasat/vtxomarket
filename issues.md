# vtxo.market — Code Review Issues

Senior-level audit, March 2026. Walk through and fix in order.

---

## CRITICAL

- [x] **C1. `hexToBytes` silently corrupts on invalid hex** — `ark-wallet.ts:71-77`, `introspector-provider.ts:242-248`, `lab/page.tsx:35-47`
  `parseInt("zz",16)` → `NaN` → `0` in Uint8Array. Odd-length strings truncate silently. Used on cryptographic scripts and keys from external API.
  **Fix:** Replace all 3 copies with `@scure/base` `hex.decode()` which throws on invalid input.

- [x] **C2. SDK singleton race condition** — `ark-wallet.ts:57-65`
  Two concurrent `getSDK()` calls both see `_sdk === null`, both trigger `import()` + opcode registration.
  **Fix:** Cache the promise, not the resolved value.

- [x] **C3. Mnemonic held in plaintext Zustand state** — `store.ts:33,92`, `useWallet.ts:42`
  Wallet mnemonic sits in plain JS accessible from DevTools/extensions. Never cleared after key derivation.
  **Fix:** Clear from store after `initArkWallet` completes. Settings page reads from IndexedDB on-demand.

- [ ] **C4. Monkey-patching wallet method not concurrency-safe** — `ark-wallet.ts:307-327, 367-385`
  `issueToken`/`reissueToken` temporarily replace `wallet.buildAndSubmitOffchainTx`. Concurrent ops race on the shared wallet object.
  **Fix:** Extract into `withOpReturnDustPatch()` wrapper with a mutex that rejects concurrent calls.

---

## HIGH

- [x] **H1. IntrospectorArkProvider: PSBT input index hardcoded** — `introspector-provider.ts:232`
  Assumes input 0 is always message input. No guard that `inputCount >= 2`. If SDK reorders inputs, arkade script injected into wrong input.
  **Fix:** Validate `inputCount >= 2`, add comment about SDK contract.

- [x] **H2. IntrospectorArkProvider: empty signedForfeits silently falls back** — `introspector-provider.ts:125-128`
  Empty array from introspector sends unsigned forfeits to ASP. Should error when swap context is active.
  **Fix:** Throw if swap context active and introspector returns empty forfeits.

- [x] **H3. IntrospectorArkProvider: non-null assertion on lastIntentMessage** — `introspector-provider.ts:116`
  Guard checks `lastSignedIntentProof` but not `lastIntentMessage`.
  **Fix:** Check both fields explicitly.

- [x] **H4. IntrospectorArkProvider: no concurrency guard** — `introspector-provider.ts:40-45`
  Second `setSwapContext` call overwrites first's state. Concurrent fills corrupt both.
  **Fix:** Throw if `setSwapContext` called while context already active.

- [x] **H5. Introspector client: no response body validation** — `introspector-client.ts:67`
  `resp.json()` cast to `T` is unchecked. Malformed response forwarded to ASP.
  **Fix:** Validate response shape before returning.

- [x] **H6. Introspector client: Content-Type on GET requests** — `introspector-client.ts:54-57`
  GET requests set `Content-Type: application/json` with no body. Strict proxies may reject.
  **Fix:** Only set header when body present.

- [ ] **H7. Unauthenticated `DELETE /offers/:outpoint`** — `indexer/api.ts:139-142`
  Anyone can cancel anyone else's offer. No proof of ownership.
  **Fix:** Require signature from maker's pubkey.

- [ ] **H8. `POST /offers` zero type/format validation** — `indexer/api.ts:114-122`
  No format check on outpoint, no numeric validation, no length limits.
  **Fix:** Add validation (Zod or manual) before DB write.

- [ ] **H9. SQLite parameter limit in `markVtxosSpent`** — `indexer/db.ts:237-247`
  `WHERE IN (?)` with one placeholder per outpoint. Limit is 999. Large Ark rounds → crash.
  **Fix:** Batch into chunks of ~900.

- [ ] **H10. `ArkProvider = any` / `ArkWallet = any`** — `introspector-provider.ts:36`, `ark-wallet.ts:6`
  All SDK calls unchecked. API changes break silently at runtime.
  **Fix:** `import type` from SDK (type-only imports work with Turbopack).

- [ ] **H11. No React Error Boundaries** — all route segments
  Single thrown error crashes entire page white.
  **Fix:** Add `error.tsx` files in each route segment.

- [ ] **H12. Silent data loss when arkd down** — `indexer/indexer.ts:104`, `ark-client.ts:42`
  Failed `fetchVtxosByOutpoints` returns `[]`, tx marked processed anyway. VTXOs lost permanently.
  **Fix:** Don't mark tx processed if fetch failed.

---

## MEDIUM

- [ ] **M1. `upsertToken` matches `ticker OR id` instead of `assetId`** — `store.ts:106`
  Two assets with same user-chosen ticker collide.
  **Fix:** Match on `assetId`.

- [ ] **M2. `useAppStore()` without selector in useWallet** — `useWallet.ts:15`
  Every state change re-renders root layout.
  **Fix:** Use individual selectors.

- [ ] **M3. TOCTOU race on `isTxProcessed`** — `indexer/indexer.ts:31-104`
  Async fire-and-forget from SSE. Same txid processed twice during reconnection replay.
  **Fix:** Add per-txid in-memory lock.

- [ ] **M4. Nostr subscription leak in strict mode** — `useTokens.ts`, `useComments.ts`, `useTrades.ts`
  `subRef.current = sub` then cleanup via ref. First subscription leaks in strict mode.
  **Fix:** Close over local `sub` variable.

- [ ] **M5. Race condition in useOffers fetch** — `useOffers.ts:32-64`
  No AbortController. Rapid assetId changes → stale responses overwrite fresh data.
  **Fix:** Thread AbortController through fetch.

- [ ] **M6. XSS from user-provided URLs** — `token/[id]/page.tsx:739`
  `token.website` from Nostr rendered as `<a href>`. `javascript:` possible.
  **Fix:** Validate `https://` before rendering.

- [ ] **M7. `new URL()` crashes dev page** — `dev/page.tsx:192`
  Malformed `arkServerUrl` → unhandled throw → page crash.
  **Fix:** Wrap in try/catch.

- [ ] **M8. N+1 offer fill detection** — `indexer/indexer.ts:46-54`
  One SELECT per spent VTXO. Batch into `WHERE IN (...)`.

- [ ] **M9. Missing DB indexes on offers** — `indexer/db.ts`
  No index on `(assetId, status)` or `(status, expiresAt)`. Full table scans.
  **Fix:** Add composite indexes.

- [ ] **M10. Dev page 2s poll with 7 state updates** — `dev/page.tsx`
  4 fetches/2s, each triggers separate setState. filteredLogs not memoized.
  **Fix:** useReducer to batch, useMemo for filteredLogs.

- [ ] **M11. `batchExpiry` ms vs seconds confusion** — `ark-wallet.ts:1252-1271`
  `isVtxoExpiringSoon` compares seconds with `Date.now()` (ms). Always returns wrong result.
  **Fix:** Verify SDK units, normalize.

- [ ] **M12. Swap offer outpoint hardcoded to `:0`** — `ark-wallet.ts:1022`
  If SDK places swap output at different vout, tracking breaks.
  **Fix:** Determine actual vout from tx structure.

- [ ] **M13. `assetMetadataFetched` Set caches failures forever** — `indexer/indexer.ts:26,77-79`
  Failed metadata fetch still added to Set. Asset has null metadata for process lifetime.
  **Fix:** Only cache on successful fetch.

- [ ] **M14. `addToken` has no dedup (race with `upsertToken`)** — `store.ts:103`
  Prepends without checking for duplicates.
  **Fix:** Remove `addToken` or delegate to `upsertToken`.

- [ ] **M15. `NDKUser` class instance in Zustand state** — `store.ts:36`
  Non-serializable, breaks persist, DevTools, creates hidden coupling.
  **Fix:** Store only `{ npub, pubkey, hexpubkey }`.

---

## LOW

- [ ] **L1. Pubkey prefix stripping repeated 4x without validation** — `ark-wallet.ts:995-1000`
  Doesn't verify prefix is `0x02`/`0x03`.
  **Fix:** Extract to utility with prefix validation.

- [ ] **L2. Magic number `330` for dust amount** — `ark-wallet.ts:1023,1071,1134`
  **Fix:** `const DEFAULT_DUST_SATS = 330;`

- [ ] **L3. Network detection via URL string matching** — `ark-wallet.ts:1462`
  Custom domains default to mainnet.
  **Fix:** Use `aspInfo.network` everywhere.

- [ ] **L4. `isBtcAddress` regex doesn't verify checksum** — `ark-wallet.ts:171-176`
  Accepts invalid addresses.
  **Fix:** Use proper bech32 validation.

- [ ] **L5. Debug console.log leaks VTXO details** — `ark-wallet.ts:94,188,342`, `introspector-provider.ts:83,108`
  **Fix:** Gate behind debug flag.

- [ ] **L6. No `reset`/logout action on store** — `store.ts`
  **Fix:** Add `reset()` action.

- [ ] **L7. Dev page hardcodes `localhost:3001`** — `dev/page.tsx:5`
  **Fix:** Use `NEXT_PUBLIC_INDEXER_URL`.

- [ ] **L8. Log entries keyed by array index** — `dev/page.tsx:369`
  Causes DOM reuse bugs on 2s poll.
  **Fix:** Key by `ts + msg`.

- [ ] **L9. 20 useState calls in token page** — `token/[id]/page.tsx`
  **Fix:** Decompose into sub-components.

- [ ] **L10. Missing aria-label on icon-only buttons** — `app-sidebar.tsx`, token page
  **Fix:** Add aria-labels.

- [ ] **L11. `navItems[5]` hardcoded index for Settings** — `app-sidebar.tsx:115`
  **Fix:** Use `.find()` lookup.

- [ ] **L12. `processed_txs` grows unboundedly** — `indexer/db.ts`
  **Fix:** Prune entries older than N days.

- [ ] **L13. `parseInt` without NaN guard on query params** — `indexer/api.ts:53`
  **Fix:** `parseInt(...) || 100`

- [ ] **L14. SSE buffer unbounded if no newlines** — `indexer/stream.ts:65-81`
  **Fix:** Add max buffer size check.

- [ ] **L15. `expireStaleOffers` interval not cleared on shutdown** — `indexer/index.ts:24`
  **Fix:** Store handle, clear in `shutdown()`.

- [ ] **L16. No persistence middleware on store** — `store.ts`
  Token list re-fetched from Nostr on every page load.
  **Fix:** Consider `persist` with `partialize` for non-sensitive data.
