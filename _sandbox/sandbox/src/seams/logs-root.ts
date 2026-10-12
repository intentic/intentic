import { join } from "node:path";

// Where the daemon's logs live under /history. In the foundation layer so subsystems that write beside the logs (the
// resource series, restart records) name it without importing the logs subsystem, which reads theirs.
export const logsRoot = (historyRoot: string): string => join(historyRoot, "logs");
