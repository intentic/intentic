// Node-safe entry point for `satisfiesEngines`/`extensionApiVersion`: the root barrel's `export *` eagerly loads every
// module including vue, which a host-side Node process (the daemon) cannot resolve. The root barrel still re-exports
// both names too.

export { satisfiesEngines } from "./engines.js";
export { extensionApiVersion } from "./version.js";
