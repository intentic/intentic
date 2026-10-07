import { existsSync } from "node:fs";

// The offloaded-command wrapper (bin/offload-run). Off where it is not baked in, which leaves every line here.
export const OFFLOAD_RUN_BIN = "/usr/local/bin/offload-run";
export const offloadRunEnabled = (): boolean => existsSync(OFFLOAD_RUN_BIN);
