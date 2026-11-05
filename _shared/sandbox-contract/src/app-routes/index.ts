// The app's addresses: the pages it has (app-pages.ts), where each is drawn and the address that says so (paths.ts), how
// an address names its sandbox (sandbox-segment.ts), and what the addresses from before frames meant (legacy.ts). The
// one place an address of the editor is spelled.
export * from "./app-pages.js";
export * from "./paths.js";
export * from "./legacy.js";
export * from "./sandbox-segment.js";
export { fillPattern, matchPattern, paramNames } from "./patterns.js";
