// The agent build, reported in the hello frame and surfaced per machine on the sandbox's card, so a computer
// running an old binary is visible there rather than mysteriously missing a tool. Stamped at COMPILE time by
// build-agent-binaries.sh (bun's --define), because the shipped artifact is a single compiled binary with no
// package.json beside it to read. See @intentic/sync's version.ts for why the hand-written literal this replaces
// was worse than no version at all, and why the `typeof` guard and the 0.0.0 fallback are the shape they are.
declare const INTENTIC_AGENT_VERSION: string | undefined;

export const HOST_VERSION: string = typeof INTENTIC_AGENT_VERSION === "string" ? INTENTIC_AGENT_VERSION : "0.0.0";
