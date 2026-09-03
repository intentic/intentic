/* THE ONE ERROR AN ARRIVAL CAN FAIL WITH THAT IS THE CALLER'S FAULT, and the reason it is a base class rather
 * than three unrelated ones.
 *
 * Four sources can arrive in a sandbox and each has its own reader, so each has its own way of saying "that
 * file is not what you think it is": a TOML document that is not a definition, a tar that is not a bundle, a
 * folder that is neither Hermes nor OpenClaw. Every one of those is a 400 with the reader's own sentence, and
 * when the three surfaces were separate each route re-derived that mapping for its own error class. One base
 * means the arrival routes catch ONCE, and a reader added later is answered correctly by construction rather
 * than by somebody remembering to widen a catch.
 *
 * It lives in a leaf module at the root of src/, above both subsystems that throw it, because the readers sit
 * in two directories (portability/ and migrations/). Inside either one it would be a value edge from the other
 * subsystem into it, and since the arrival pipeline in portability/ already calls the migrations readers, that
 * edge closed a runtime cycle between the two (_tools/checks/daemon-boundaries.mjs). Raising an error is no reason to
 * import another subsystem's surface.
 */
export class ArrivalFormatError extends Error {}

/* A held plan that no longer matches: the token names an artifact this daemon has already consumed, or has
 * forgotten across a restart. Distinct from the above because the answer differs — the file was fine, the
 * PREVIEW went stale, so the route answers 409 and the card re-reads rather than telling the owner their
 * file is malformed. */
export class ArrivalStaleError extends Error {}
