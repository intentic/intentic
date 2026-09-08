import { errorMessage } from "@intentic/base/errors";
// Compiled single-file binaries produce stack frames into a virtual path with no source map, useless to the user and
// unmappable by us; this returns just the message so a thrown error reads as a one-line problem, not a crash, during
// install.
export const agentException = (exc: unknown): string => errorMessage(exc);
