// HOW A SANDBOX RUNS, a fact about the sandbox rather than about whoever is looking at it. It is chosen where the
// sandbox is made ("Who handles the code here?"), kept in its own settings (settings.json `mode`), and a maintainer can
// change it later.
//
// - hands-on: you review and ship the work. Every setting is yours, as it always was.
// - hands-off: the sandbox lands finished work, saves it as a version and backs it up, and owns those settings. Its
//   editor speaks plain words to everyone who has not chosen otherwise for themselves.
//
// Here, not in the sandbox contract, because the platform takes it when it provisions a machine, the site preselects
// it, and both name it without importing the sandbox's schemas.

export const SANDBOX_MODES = ["hands-on", "hands-off"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

// What a sandbox that never said runs as: every sandbox from before the choice existed, which keeps behaving as it did.
export const DEFAULT_SANDBOX_MODE: SandboxMode = "hands-on";

// For a string that arrives naming a mode from outside a schema: a stored preselect, a link's query.
export const isSandboxMode = (value: string | null | undefined): value is SandboxMode => SANDBOX_MODES.some((mode) => mode === value);
