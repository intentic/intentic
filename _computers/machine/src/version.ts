/* WHICH BUILD OF THIS AGENT IS RUNNING, reported in the host hello frame and the machine report, so a computer
 * running a five-day-old agent is a fact on the Computers row rather than a mystery about why it behaves unlike
 * the docs.
 *
 * Stamped at COMPILE time (build-agent-binaries.sh passes bun's --define), not read at runtime: the shipped
 * artifact is a single compiled binary with no package.json beside it to read. It used to be a hand-written
 * literal, which is a version only in the sense that it is a string, nobody ever bumped it, so every machine
 * ever paired reported the same "0.1.0" and the row printed that as fact. The skew it was supposed to make
 * visible then cost a user a day of frozen repositories while the answer sat on screen, wrong, the whole time.
 *
 * The `typeof` guard is what makes this unable to fail rather than merely unlikely to: an undeclared identifier
 * is a ReferenceError to READ but safe to `typeof`, so a build that somehow misses the define, the npx fallback
 * running dist/cli.js, a local `bun build` without it, falls back instead of refusing to start. A version
 * string is not worth a binary that will not boot.
 *
 * And it falls back to the SAME 0.0.0 sentinel the daemon uses for a working-tree build, which is the safe
 * direction on purpose: an unstamped build reads as "not a release" rather than as some specific version it is
 * not, and the staleness check treats it as unknown instead of telling anyone they are current. */
declare const INTENTIC_AGENT_VERSION: string | undefined;

export const MACHINE_VERSION: string = typeof INTENTIC_AGENT_VERSION === "string" ? INTENTIC_AGENT_VERSION : "0.0.0";
