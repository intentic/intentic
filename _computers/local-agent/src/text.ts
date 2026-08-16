/* WHAT A FAILING AGENT SAYS TO THE PERSON RUNNING IT — a sentence, not a stack.
 *
 * The CLI framework reports a thrown Error as `exc.stack`, and these agents ship as COMPILED SINGLE-FILE
 * BINARIES. So the frames a user sees name a virtual path inside the executable, with no source map behind it:
 *
 *   Command failed, Error: enrolling the sync key failed (409): {"error":"this sandbox has no SSH tunnel..."}
 *       at <anonymous> (B:/~BUN/root/intentic-sync-windows-amd64.exe:22262:22)
 *       at async runCommand (B:/~BUN/root/intentic-sync-windows-amd64.exe:951:46)
 *       ...
 *
 * Five lines that locate nothing — not for the user, who cannot act on them, and not for us, who cannot map
 * them back to a line of source. Worse, they arrive DURING an install: the desktop app streams this straight
 * onto its setup screen, where a wall of frames under a one-line problem reads as a crash rather than as the
 * one step that did not finish.
 *
 * Every throw in these CLIs is a sentence written for the person reading it — an expired pairing, a sandbox
 * that cannot do sync, a background loop that died naming its own log. That sentence is the whole of what is
 * worth showing, so that is what is shown.
 *
 * A plain function rather than the framework's text object, so this package keeps its "no dependencies of its
 * own" shape: each agent already builds that object, and this is the one field they must agree on. */
export const agentException = (exc: unknown): string => (exc instanceof Error ? exc.message : String(exc));
