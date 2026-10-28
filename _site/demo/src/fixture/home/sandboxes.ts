import { DEMO_DAEMON_ORIGIN } from "../../transport";

// THE HOME RECORDING'S THREE SANDBOXES, each answered at a daemon address of its own, so switching between them in the
// rail switches what their home conversations hold. One fixture daemon still answers all three (transport.ts claims
// every `*.demo.invalid` host): a call's address (ProcedureCall.url) is how it tells them apart. Only the home
// conversation differs; the board, files and the rest are the one shop's.

export const HOME_SANDBOXES = {
    // The shop is the demo's own sandbox (platform.ts DEMO_SANDBOX), at the address every mode uses.
    shop: { id: `demo`, origin: DEMO_DAEMON_ORIGIN },
    research: { id: `demo-research`, origin: `https://research.demo.invalid` },
    personal: { id: `demo-personal`, origin: `https://personal.demo.invalid` },
} as const satisfies Readonly<Record<string, { readonly id: string; readonly origin: string }>>;

/** One of the three the recording plays a story in. */
export type RecordedSandbox = keyof typeof HOME_SANDBOXES;

/** A sandbox the visitor made on the page, by its daemon address: no story, its home conversation empty until written in. */
export type MadeSandbox = `made:${string}`;

/** Whose home conversation a call is about: one of the recording's three, or one the visitor made (sandboxAt.ts). */
export type HomeSandbox = RecordedSandbox | MadeSandbox;

const ORDER: readonly RecordedSandbox[] = [`shop`, `research`, `personal`];
const BY_ORIGIN = new Map<string, RecordedSandbox>(ORDER.map((sandbox) => [HOME_SANDBOXES[sandbox].origin, sandbox]));

/** Which of the three a call was sent to, if any. */
export const recordedSandboxAt = (url: URL): RecordedSandbox | undefined => BY_ORIGIN.get(url.origin);
