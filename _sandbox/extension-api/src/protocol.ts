/* THE HALF OF THIS PACKAGE THAT RUNS WITHOUT A BROWSER, the protocol version and the matcher that compares a
 * manifest's `engines.intentic` against it.
 *
 * The root barrel is the EXTENSION-facing surface, and an extension runs in the app, so the barrel is free to
 * reach for vue: `scope.ts` imports `ref` as a value, not a type. The daemon is the other consumer, and it
 * needs exactly these two names, to refuse an incompatible extension (backend-supervisor), to stamp the
 * version it provides (backend-host-main), to write an engines range into a scaffold. It has no vue and no
 * reason to grow one, but `export *` loads every re-exported module eagerly, so importing the barrel for
 * `extensionApiVersion` alone dragged `vue` into a Node process that could not resolve it, the daemon crashed
 * on boot and the sandbox never became healthy.
 *
 * Hence this entry point. `@intentic/extension-api/protocol` is what host-side Node code imports; the root
 * barrel keeps exporting both names too, so nothing about the published extension surface changes. Type-only
 * imports from the root (`ExtensionServerApi` and friends) stay where they are, those are erased at compile
 * time and never reach the loader. */

export { satisfiesEngines } from "./engines.js";
export { extensionApiVersion } from "./version.js";
