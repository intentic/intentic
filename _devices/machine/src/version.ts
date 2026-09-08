// Which build is running, reported in the host hello frame and the machine report. Stamped at compile time
// (bun's --define); `typeof` lets a missing define fall back instead of crashing on an undeclared identifier.
// Falls back to 0.0.0, the same sentinel the daemon uses for a working-tree build, so staleness reads as unknown, not a
// false match.
declare const INTENTIC_AGENT_VERSION: string | undefined;

export const MACHINE_VERSION: string = typeof INTENTIC_AGENT_VERSION === "string" ? INTENTIC_AGENT_VERSION : "0.0.0";
