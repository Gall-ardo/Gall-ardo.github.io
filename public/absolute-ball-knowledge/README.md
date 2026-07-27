# Absolute Ball Knowledge data behaviour

Firestore is the source of truth. Player ratings, games, wins, and losses are never stored as authoritative values: the browser rebuilds them from the complete recorded match history using `score_logistic_v1`.

## Editing and deleting

- Renaming preserves the player document ID, so match references remain valid and the live UI uses the new name. Historical name snapshots in older match documents, if any, are intentionally not rewritten.
- A player can be deleted only after the browser finds no match that references them. It re-queries immediately before the confirmed deletion and never cascade-deletes matches.
- Editing a match preserves its document ID and `createdAt`, writes `updatedAt`, validates current player documents in a transaction, and triggers a complete ratings/statistics rebuild. Deleting a match rebuilds from the remaining history.
- A match edit never rewrites `modelVersion`. Re-sending it would add the field to any document that predates it, which the security rules reject as an unexpected field change.

## Concurrency

The Firestore Web SDK's `DocumentSnapshot` carries no document version — `updateTime` exists only on the Admin SDK — so every edit and delete uses the `updatedAt` the client itself writes as its optimistic-concurrency token, falling back to `createdAt` for documents written before `updatedAt` existed. A document with neither is unguarded and the mutation proceeds. A mutation whose token no longer matches is refused with "This record changed in another browser."

A Firestore transaction can only read document references, never queries. Duplicate-name scans therefore run before the transaction opens, and every candidate they return is re-read by reference inside it. That drops candidates renamed away in the meantime and puts the rest in the transaction's read set.

Three constraints cannot be enforced by the security rules, and `firestore.rules` documents all of them:

- **Unused-player deletion.** Rules cannot query the whole `matches` collection, so the browser's re-check is the only guard. Another client can record a match naming that player between the check and the delete, leaving a match that references a deleted player; the rebuild renders those as "Unknown player" rather than failing.
- **Name uniqueness.** The pre-transaction scan cannot see a name claimed after it ran, and the rules cannot scan `players` at all.
- **Duplicate IDs inside one team.** The rules language cannot deduplicate or iterate a list, so `validateMatch` in the browser is the only thing that rejects a team naming the same player twice. The related constraint — the same player on *both* teams — is expressible through `hasAny` and the rules do enforce it.

The rules also do not check that a team's IDs name player documents that exist; that would need one `get()` per member.

Closing any of these needs a Cloud Function or a data model that makes the constraint a document key, such as a `playerNames/{normalizedName}` reservation document.

## Validation shared with the security rules

`firestore.rules` and the browser bound the same values, and the bounds have to stay in step or a name the browser accepts becomes an unexplained permission error:

- **Name length, 2 to 40.** Firestore Rules `string.size()` counts UTF-16 code units, exactly like JavaScript's `String.length` — not bytes and not code points. An astral character such as an emoji or `𝐀` counts 2 on both sides, and a combining mark counts as its own unit on both. `cleanPlayerName` bounds `normalizedName` as well as `name`, because lowercasing "İ" yields `i` plus a combining dot and doubles the length.
- **Team size, at most 20.** `MAX_TEAM_SIZE` in `js/mutations.js` mirrors the ceiling in the rules' `validTeam`, and is applied on the write paths only. `validateMatch` itself does not enforce it, because it also parses recorded history, which must stay readable whatever it holds.

`test/firestore-rules.test.js` pins both against the emulator.

## Local testing

`?mock=1` swaps in an in-memory Firestore-shaped adapter (`js/firebase-mock.js`). It is opt-in and affirmative-only: `?mock`, `?mock=1`, `?mock=true`, `?mock=yes` and `?mock=on` enable it, while `?mock=0`, `?mock=false` and every other URL use real Firestore. The adapter holds data in memory, never touches `localStorage` or the network, and starts from a fixed seed on every page load, so a reload discards changes. Tabs in one browser profile share writes over a `BroadcastChannel`; separate profiles and incognito windows each start from their own seed and do not see writes made before they opened.

The adapter deliberately mirrors the Web SDK rather than the Admin SDK: its snapshots expose only `id`, `exists()`, `data()` and `metadata`, and `Transaction.get` rejects a query. `test/adapter.test.js` asserts both, so mock-only behaviour cannot reach production unnoticed. It does not simulate transaction rollback or retry — writes apply as they are issued — so it cannot exercise Firestore's contention handling.

`?emulator=1` points the real SDK at the Firebase Emulator Suite (`firebase emulators:start --only firestore`, which needs a JDK on the PATH). Do not point test runs at production Firestore.

Run `npm test` for the unit and adapter suites and `npm run check:js` to parse every module.

`npm run test:rules` exercises `firestore.rules` against the emulator. It needs a JDK on the PATH and a running emulator, which is why it is not part of `npm test`:

```
firebase emulators:start --only firestore --project demo-abk
npm run test:rules
```

The suite fails closed rather than skipping: it refuses a non-loopback host and a project ID without the `demo-` prefix, uploads the repository's own `firestore.rules` on every run, and throws if the emulator is unreachable.

`firestore.rules` is local only. Review and publish it manually with your normal Firebase release process; this repository change does not publish rules.
