# Porting @bsv/webrtpay to ts-stack

How to land this package at `packages/messaging/webrtpay` in
[bsv-blockchain/ts-stack](https://github.com/bsv-blockchain/ts-stack) as a draft PR (Ruling 32).
Nothing here has been done in ts-stack yet. Every path, count and specifier below was read from
the ts-stack checkout at `main` = `cf6f1c08d` on 2026-10-18; counts move as other packages land, so
re-read each one on the branch rather than trusting the numbers here.

This file is a maintainer note for the move. It is not published (it is not in `files`).

## 0. Before the first edit

1. **BotBoard.** Every agent turn on ts-stack for `sirdeggen` opens a BotBoard Discussion first
   (root `AGENTS.md`, section "Maintainer BotBoard and Lockfile protocol"; recipes in
   `docs/reference/botboard.md`): title `[BotBoard][active] sirdeggen / <agent> — <goal>`, a
   `botboard/v1` Lockfile in `turn.md`, a 15-minute lease with a heartbeat at least every 5
   minutes, and a closeout (`[BotBoard][closed]`, empty scope) before the turn ends.
2. **Read every open BotBoard thread** and its Lockfile. The port edits shared governance files
   that other maintainers' agents also edit: `governance/package-release-notes.json`,
   `governance/mutation-testing/policy.json` and `targets.mjs`, `governance/test-quality/policy.json`,
   `governance/repository-health/{projects,baselines}.json`,
   `governance/npm-package-supply-chain.json`, `governance/browser-artifact-policy.json` and the
   count literals in `scripts/*.test.mjs`. Message each live handle whose scope covers one of them
   and wait for its acknowledgement before editing it. On 2026-10-17 two such handles were live
   (#1209, wallet PR 569; #1210, utxo PR 674); check the board again, they may have closed or been
   joined by others.
3. **Discuss first.** `CONTRIBUTING.md` asks for a discussion before a new package; open the work
   as a **draft** PR. Never publish, tag a release or deploy from a workstation.
4. Work in a fresh worktree from `origin/main` (`git worktree add`), not in the primary checkout:
   other agents have live worktrees.

## 1. Package files (`packages/messaging/webrtpay/`)

| Path | From WebRTPay | Notes |
| --- | --- | --- |
| `src/`, `server/`, `test/` | as they are | `test/helpers/` included; `test/turn.test.ts` stays skipped unless `RUN_TURN_TESTS=1` |
| `docs/protocol.md` | as it is | package docs live in the package (`README`, `docs/`, `specs/`) |
| `examples/demo-node.ts` | as it is | imports `@bsv/webrtpay` by name: keep the `paths` mapping in `tsconfig.json` |
| `docker/docker-compose.yml`, `docker/turnserver.conf` | as they are | the local coturn stack `test:turn` needs; development only |
| `docker/relay.Dockerfile` | maintainer's call | the relay image is deployed from bsva-infra-flux; services under `infra/` need the heavy service registrations, so do not add one |
| `README.md` | as it is, then edit | swap the "not on npm yet" install text and the `sirdeggen/WebRTPay` links for ts-stack ones |
| `LICENSE.txt` | **no**: `cp ../../../LICENSE.txt .` | must be byte-identical to the root file (`scripts/package-license-policy.mjs` pins its sha256) |
| `AGENTS.md` | **no**: generated | run `pnpm contributor-policy:sync` |
| `package.json` | rewritten (section 2) | |
| `tsconfig.json`, `tsconfig.build.json` | rewritten (section 3) | |
| `jest.config.js` | rewritten (section 3) | |
| `browser-budget.json` | new (section 3) | |

Leave out: `package-lock.json` (pnpm's lock is the root `pnpm-lock.yaml`), `.prettierrc.json`
and `.nvmrc` (the root's apply), `.gitignore` (the root ignores `dist/`, `coverage/`,
`node_modules/`), `dist/`, and the untracked `demo/` and `signaling-server/` prototypes.
`THIRD_PARTY_NOTICES.md` and `LICENSES/` are not needed: nothing third-party is incorporated and
`@bsv/sdk` stays a peer. Package-local CI, `CONTRIBUTING`, PR templates and `.github/` are
forbidden (`scripts/contributor-policy.mjs`).

## 2. package.json

Fields `scripts/repository-health.mjs` (public manifest checks), `check-versions.mjs`,
`check-package-artifact.mjs` and `check-sdk-peer.mjs` enforce, with this package's values:

```json
{
  "name": "@bsv/webrtpay",
  "version": "0.1.0",
  "description": "Direct wallet-to-wallet BSV payments over WebRTC data channels, authenticated with BRC-100 identity keys",
  "author": "BSV Association",
  "license": "SEE LICENSE IN LICENSE.txt",
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public" },
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": {
    ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js", "default": "./dist/src/index.js" },
    "./server": { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.js", "default": "./dist/server/index.js" },
    "./package.json": "./package.json"
  },
  "typesVersions": { "*": { "server": ["dist/server/index.d.ts"] } },
  "bin": { "webrtpay-relay": "dist/server/cli.js" },
  "files": ["dist", "docs/protocol.md", "examples", "README.md", "LICENSE.txt"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "format:check": "pnpm --workspace-root exec prettier --check \"packages/messaging/webrtpay/**/*.{json,md,ts}\"",
    "lint": "oxlint src server test examples --deny-warnings",
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --watchman=false",
    "test:coverage": "node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage --runInBand --watchman=false",
    "test:property": "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --watchman=false test/codec.property.test.ts test/frames.property.test.ts",
    "test:turn": "RUN_TURN_TESTS=1 node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --watchman=false",
    "test:browser": "pnpm build && node ../../../scripts/check-browser-package.mjs .",
    "pack:check": "pnpm build && node ../../../scripts/check-package-artifact.mjs . --modes esm --exports DirectPayClient,PeerLink,authenticate,decodeCode,encodeOfferCode,encodeAnswerCode,acceptDirectPayment,verifyDirectPayment,validatePaymentToken,MessageBoxSignaler,RelaySignaler,createMemoryHub,WebRTPayError --entry-exports \"./server=createRelayServer|turnCredentials|DEFAULT_RELAY_LIMITS\" --bin webrtpay-relay --bin-args --help",
    "prepublishOnly": "pnpm build"
  },
  "dependencies": { "ws": "^8.21.3" },
  "peerDependencies": { "@bsv/sdk": "^2.8.6 || ^3.0.0" },
  "peerDependenciesMeta": { "@bsv/sdk": { "optional": false } },
  "devDependencies": {
    "@bsv/message-box-client": "workspace:^",
    "@bsv/sdk": "workspace:^",
    "@jest/globals": "^30.5.1",
    "@types/jest": "^30.0.0",
    "@types/node": "^26.6.1",
    "@types/ws": "^8.18.1",
    "@typescript/native": "npm:typescript@7.0.2",
    "fast-check": "^4.9.0",
    "jest": "^30.5.1",
    "node-datachannel": "^0.33.4",
    "oxlint": "^1.83.0",
    "ts-jest": "^29.4.12",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/bsv-blockchain/ts-stack.git",
    "directory": "packages/messaging/webrtpay"
  },
  "homepage": "https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay#readme",
  "bugs": { "url": "https://github.com/bsv-blockchain/ts-stack/issues" },
  "keywords": ["bsv", "webrtc", "p2p", "payments", "brc-100", "peerpay"]
}
```

- `@typescript/native` and `typescript` must be exactly those two specifiers
  (`scripts/typescript-toolchain.mjs`: `NATIVE_TYPESCRIPT_SPECIFIER`,
  `COMPATIBILITY_TYPESCRIPT_SPECIFIER`). The package has only been compiled with TypeScript 5.9
  so far: build, typecheck and test it under the TypeScript 6 compatibility compiler.
- `@bsv/sdk` is a peer with a wide range plus a `workspace:^` dev dependency, never a regular
  dependency (`scripts/check-sdk-peer.mjs`). `@bsv/message-box-client` is a dev dependency only,
  for the type-level interop test (`test/types.test.ts`); in WebRTPay it is pinned at `2.6.0`.
- `ws` stays a regular dependency, imported only under `server/` (the `@bsv/wallet-relay`
  precedent); `test/browser-safety.test.ts` keeps it out of `src/`.
- `node-datachannel` is a dev dependency only. Its native code ships in optional platform
  packages without install scripts, so no `allowBuilds` entry should be needed in
  `pnpm-workspace.yaml`; confirm with `pnpm install --ignore-scripts` on the branch, and that the
  workspace `trustPolicy` accepts it.
- If `test` runs with `--experimental-vm-modules`, `test:coverage` must too; `lint` passes
  `--deny-warnings` and does not exclude tests; neither mutates files.
- `pack:check` with `--bin` runs the installed `webrtpay-relay` with `--help`, which must exit 0.
  **Code change needed first:** `server/cli.ts` has no `--help` today (without `PUBLIC_URLS`
  it exits 1). Add a `--help` that prints the variables and exits 0, or drop the `cli` consumer
  profile and `--bin` (section 4).

## 3. Config files

- **`tsconfig.json`** extends an approved profile in `config/typescript/` (`dual-runtime.json`,
  as chirp does), with strict options on and `noUnusedLocals` / `noUnusedParameters` false
  (`scripts/typescript-toolchain.mjs`). Keep `lib: ["ES2022", "DOM"]` (the WebRTC types) and the
  `paths` mapping `"@bsv/webrtpay": ["./src/index.ts"]` for the example. Include `src`,
  `server`, `test` and `examples` for `typecheck`.
- **`tsconfig.build.json`** extends `tsconfig.json` (so it extends the profile too) with
  `rootDir: "."`, `outDir: "dist"`, `declaration: true`, `include: ["src", "server"]`:
  `server/` sits beside `src/`, so the build emits `dist/src/…` and `dist/server/…` (Ruling 9).
  Moving `server/` under `src/` would break `test/browser-safety.test.ts`'s rule that `src/` is
  browser-safe.
- **`jest.config.js`**: chirp's ESM shape (`ts-jest/presets/default-esm`,
  `extensionsToTreatAsEsm`, the `.js` mapper, `transform` with `useESM: true` and
  `tsconfig: 'tsconfig.json'`, `testMatch: ['<rootDir>/test/**/*.test.ts']`), plus
  `collectCoverageFrom: ['src/**/*.ts', 'server/**/*.ts']` and `testTimeout: 60000` (real
  WebRTC tests). Measure coverage before choosing a `coverageThreshold` (chirp uses
  90/85/90/90).
- **`browser-budget.json`** (`scripts/check-browser-package.mjs`):
  `{ "schemaVersion": 1, "profile": "browser", "package": "@bsv/webrtpay", "entry": ".",
  "requiredExports": ["DirectPayClient", "PeerLink", "authenticate", "decodeCode",
  "acceptDirectPayment", "RelaySignaler", "MessageBoxSignaler"], "prohibitedExports":
  ["createRelayServer", "turnCredentials", "DEFAULT_RELAY_LIMITS"], "maximumBytes": { "vite":
  {…}, "esbuild": {…} } }`. Start with generous placeholders, run
  `node ../../../scripts/check-browser-package.mjs . --measure`, then set the limits with about
  10% headroom (`governance/browser-artifact-policy.json` `growthPolicy`). The root entry imports
  no Node builtin, `ws` or `node:` module, which the checker refuses in a browser graph.
- **README** already has what `scripts/documentation-policy.mjs` wants: an H1 with the package
  name, `## Install` and `## Quick start`, fenced code, `## License` linking `LICENSE.txt`.

## 4. Governance registrations

| File | Change |
| --- | --- |
| `governance/repository-health/projects.json` | add `{ "path": "packages/messaging/webrtpay", "name": "@bsv/webrtpay", "owner": "ts-stack-maintainers", "area": "messaging", "profile": "browser-library", "consumerProfiles": ["browser-bundler", "browser-esm", "cli", "node-esm"], "criticality": "tier-1", "runtimeTargets": ["browser", "node"], "release": "npm-oidc" }` (chirp's shape: ESM only, with a bin; `consumerProfiles` sorted). The `browser-library` profile requires the scripts `build`, `format:check`, `lint`, `pack:check`, `test`, `test:browser`, `test:coverage`, `typecheck`; `browser-*` needs `test:browser` to run `check-browser-package.mjs`; `node-esm` needs `pack:check` to exercise ESM; `cli` needs `pack:check` to pass `--bin`. Projects: 41 → 42. |
| `governance/repository-health/baselines.json` | `workspace.projects` 41 → 42, `workspace.packageAreaProjects` 36 → 37, `workspace.publicPackages` 33 → 34 (`privatePackageAreaProjects` stays 3); `publicPackageVersions["@bsv/webrtpay"] = "0.1.0"` (must equal `package.json`) |
| `governance/package-release-notes.json` | add to `entries` (33 → 34): `{ "name": "@bsv/webrtpay", "publishedVersion": "0.0.0", "releaseType": "minor", "summary": "<at least 20 characters: first release; direct BRC-100-authenticated payments over WebRTC data channels, MessageBox and relay signaling, and a relay server subpath>", "migration": "No consumer migration required; first release." }` (`releaseType` must match 0.0.0 → 0.1.0, `scripts/package-documentation.mjs`) |
| `governance/npm-package-supply-chain.json` | `publicPackageCount` 33 → 34 |
| `governance/browser-artifact-policy.json` | add to `packages` (17 → 18): `{ "name": "@bsv/webrtpay", "path": "packages/messaging/webrtpay", "budget": "packages/messaging/webrtpay/browser-budget.json", "entry": ".", "splittingDisposition": "Browser entry only; the Node relay server is the separate ./server subpath and never enters the browser graph." }` |
| `governance/test-quality/policy.json` | `propertyTesting.manifests` += `packages/messaging/webrtpay/package.json` (31 → 32); two `propertyTesting.suites` entries (37 → 39), below |
| `governance/mutation-testing/policy.json` | two `targets` (37 → 39), below |
| `governance/mutation-testing/targets.mjs` | the two matching target definitions, below |

**Property suites (route A).** The package parses hostile peer input (codes, SDPs, frames,
JSON), so it gets property suites rather than an exclusion. Both suites are already in the
governance format: they import `fast-check`, call `fc.configureGlobal` and `fc.assert`, set
`const MIN_PROPERTY_RUNS = 300` (the policy's `minimumRuns`) and honour
`process.env.FAST_CHECK_NUM_RUNS`, `FAST_CHECK_SEED` and `FAST_CHECK_PATH`; the manifest's
`test:property` names both files.

```json
{
  "path": "packages/messaging/webrtpay/test/codec.property.test.ts",
  "manifest": "packages/messaging/webrtpay/package.json",
  "risk": "high",
  "boundary": "Offer and answer codes and compact SDPs scanned from QR codes or pasted by strangers",
  "target": "Code and compact-SDP round trips, and decoder totality on arbitrary, hostile or mutated input",
  "invariants": [
    "Arbitrary offer and answer fields round-trip through a code unchanged.",
    "Arbitrary bytes, text, hostile TLVs and mutated valid codes only ever throw WebRTPayError.",
    "Arbitrary candidate lists and transport parameters round-trip through the compact SDP form.",
    "SDP text that cannot be compacted round-trips byte for byte through the fallback form."
  ]
},
{
  "path": "packages/messaging/webrtpay/test/frames.property.test.ts",
  "manifest": "packages/messaging/webrtpay/package.json",
  "risk": "critical",
  "boundary": "Data channel frames from an unauthenticated or authenticated WebRTC peer",
  "target": "Frame chunking round trips, and the decoder's sequence, size and JSON structure bounds on hostile streams",
  "invariants": [
    "Random message sequences survive chunking and reassembly whole and in order.",
    "A stream that starts at any sequence number other than 0 is a protocol error.",
    "The size cap fires on exactly the first frame whose running total passes it.",
    "Random, corrupted, truncated, dropped, duplicated and reordered frames only ever throw WebRTPayError.",
    "Exactly the JSON objects within the depth and structural-token limits are accepted, for any text."
  ]
}
```

Each invariant names a property the suite asserts today; keep them in step if the suites
change.

Mutation targets, `policy.json` (`minimumScore` 80–85 in precedents, `maximumNoCoverage: 0`,
`maximumInvalid: 0`):

```json
{ "id": "webrtpay-codes", "manifest": "packages/messaging/webrtpay/package.json", "propertyTest": "packages/messaging/webrtpay/test/codec.property.test.ts", "risk": "high", "boundary": "Offer and answer codes and compact SDPs from strangers", "minimumScore": 80, "maximumNoCoverage": 0, "maximumInvalid": 0 },
{ "id": "webrtpay-frames", "manifest": "packages/messaging/webrtpay/package.json", "propertyTest": "packages/messaging/webrtpay/test/frames.property.test.ts", "risk": "critical", "boundary": "Data channel frames from WebRTC peers", "minimumScore": 85, "maximumNoCoverage": 0, "maximumInvalid": 0 }
```

and in `targets.mjs`:

```js
'webrtpay-codes': {
  packageDirectory: 'packages/messaging/webrtpay',
  manifest: 'packages/messaging/webrtpay/package.json',
  propertyTest: 'packages/messaging/webrtpay/test/codec.property.test.ts',
  mutate: ['src/codec/codes.ts', 'src/codec/sdp.ts'],
  ...jestTarget('jest.config.js', ['<rootDir>/test/codec*.test.ts'], { esm: true })
},
'webrtpay-frames': {
  packageDirectory: 'packages/messaging/webrtpay',
  manifest: 'packages/messaging/webrtpay/package.json',
  propertyTest: 'packages/messaging/webrtpay/test/frames.property.test.ts',
  mutate: ['src/channel/frames.ts'],
  ...jestTarget('jest.config.js', ['<rootDir>/test/frames*.test.ts'], { esm: true })
}
```

Run the mutation campaign for both targets before choosing the scores.

## 5. Hard-coded counts in `scripts/*.test.mjs`

`node --test scripts/*.test.mjs` is part of `pnpm health:check`. With one new public package and
two property suites:

| File | Line | Change |
| --- | --- | --- |
| `scripts/repository-health.test.mjs` | 43 (test title), 46, 83 | projects 41 → 42 |
| `scripts/repository-health.test.mjs` | 47, 84, 231, 285 | public packages 33 → 34 |
| `scripts/repository-health.test.mjs` | 70 | package manifests 50 → 51 |
| `scripts/package-documentation.test.mjs` | 11 | 33 → 34 |
| `scripts/package-license-policy.test.mjs` | 28 | `discoverPackageManifests().length` 50 → 51 |
| `scripts/typescript-toolchain.test.mjs` | 29 | `governed` 47 → 48 |
| `scripts/contributor-policy.test.mjs` | 17 | `scopedProjectsAndServices` 47 → 48 |
| `scripts/test-governance.test.mjs` | 36–40 | `propertySuites` 37 → 39, `propertyPackages` 31 → 32, `propertyExcludedPackages` stays 5, `propertyClassifiedPackages` 36 → 37, `mutationTargets` 37 → 39 |

`scripts/check-package-license-tarballs.mjs`, `package-release-artifacts.mjs` and
`package-documentation.mjs` read the registry and `publicPackageCount`; they need no edit.

## 6. Documentation

- **`docs/packages/messaging/webrtpay.md`** (required by `scripts/documentation-policy.mjs`;
  schema `docs/_schemas/page.schema.json`). Front matter as `message-box-client.md` has it:
  `id: pkg-webrtpay`, `title: '@bsv/webrtpay'` (must equal the package name), `kind: package`,
  `domain: messaging`, `version: '0.1.0'` (must equal `package.json`), `source_repo:
  'bsv-blockchain/ts-stack'`, `last_updated`, `last_verified`, `review_cadence_days: 30`, `npm:
  'https://www.npmjs.com/package/@bsv/webrtpay'`, `repo:
  'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay'`, `status:
  experimental`, `tags: [messaging, webrtc, payments, brc-29, brc-100]`. No `source_commit:`.
  Sections as other package pages: Install, Quick start, What it provides, Security, links to
  `docs/protocol.md`.
- **Index rows** (convention, not enforced): a table row in `docs/packages/messaging/index.md`
  and a bullet in `docs/packages/index.md`; optionally `docs-site/src/lib/nav.ts`.
- **Generated pages**: run `pnpm docs:facts` (regenerates `docs/reference/stack-facts.md` and
  `docs/reference/package-api-migrations.md`); never hand-edit them. `pnpm docs:facts:check` is
  in `health:check`.
- Optionally list the package in `docs/guides/peer-to-peer-messaging.md` and add its path to
  `governance/documentation-policy.json` `freshness.sourcePaths`.

## 7. Lockfile and operator lists

- `pnpm install --lockfile-only --ignore-scripts` and commit `pnpm-lock.yaml`: CI installs with
  `--frozen-lockfile`. `autoInstallPeers` is false, so every peer is declared explicitly.
- `scripts/patch-coverage.mjs`: add an exact-path regex for `server/index.ts`, a pure re-export
  barrel (follow the chirp/lch comments there). `src/index.ts` and `src/types.ts` are not pure:
  they define `VERSION`, `DEFAULTS` and `isIdentityKey`, so they stay in the boundary.
- `scripts/configure-ts-stack-npm-trust.sh`: add `"@bsv/webrtpay"` to `PKGS`. How the first OIDC
  trusted-publisher binding is set up for a name not yet on npm is undocumented: an operator
  step.

## 8. Validate on the branch

1. `pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild`
2. `node --test scripts/*.test.mjs`, `pnpm contributor-policy:check`, `pnpm docs:facts:check`,
   `node scripts/dependency-release-governance.mjs check`,
   `node scripts/browser-artifact-governance.mjs`, `node scripts/typescript-toolchain.mjs`,
   `node scripts/package-license-policy.mjs`, `node scripts/third-party-license-policy.mjs`,
   `node scripts/test-governance.mjs`, `node scripts/repository-health.mjs`,
   `node scripts/check-sdk-peer.mjs`
3. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, then in the package `build`, `test`,
   `test:coverage`, `test:property`, `pack:check` and `test:browser`. The package has never run
   `oxlint` or the root Prettier glob over `json` and `md` files: expect fixes.
4. `pnpm audit:security`; `node scripts/ci-local-feedback.mjs --base origin/main` for the CI plan.
5. Push the branch, open the PR as a draft, and close the BotBoard handle.

## 9. After the port

- bsv-desktop consumes a tarball packed from ts-stack (`pnpm --filter @bsv/webrtpay pack`)
  until the first publish; `pnpm pack` rewrites `workspace:^` to concrete ranges, and the package
  has no first-party runtime dependency that would need to resolve on npm.
- The relay image and the coturn deployment stay in bsva-infra-flux.
- Archive or redirect `sirdeggen/WebRTPay` once ts-stack is the source of truth.
