// The browser extension's entire import surface from this package, and the reason it is a separate entry point:
// `src/index.ts` reaches every schema and contract in the repo, and the extension's bundle is uploaded to a store,
// where ~400 kB of the daemon's unrelated wire surface is both dead weight and something a reviewer has to account for.
// Nothing here may import that barrel, or the saving is silently undone — `pnpm --filter @intentic/webext build`
// checks the bundle against the ceiling in _devices/webext/scripts/size-budget.mjs.
export { webextContract } from "../contracts/webext.contract.js";
export * from "../protocol/webext-links.js";
export * from "../protocol/webext-protocol.js";
export * from "../schemas/webext.js";
