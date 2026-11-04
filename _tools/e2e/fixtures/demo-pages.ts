import { homePath, insidePath, type PageLink } from "@intentic/sandbox-contract/app-routes";

// The demo's addresses, for the suites that run against it with its base (`/demo/`) as their baseURL: each relative to
// that base, so `page.goto` resolves it under the demo, and each in the frame and sandbox it names.

/** The demo account's own sandbox, the one every demo load opens (_site/demo/src/world/account.ts `DEMO_SANDBOX`). */
export const DEMO_SANDBOX = `demo`;

/** A page of the demo's sandbox at its address inside it (`s/demo/agents`), the sandbox's landing with no page. */
export const demoPage = (link?: PageLink): string => insidePath(DEMO_SANDBOX, link).slice(1);

/** Home's frame: bare (`home`), around the demo's sandbox, or an account page (`home/account/appearance`). */
export const demoHome = (link?: PageLink, sandbox?: string): string => homePath(sandbox, link).slice(1);
