import { existsSync } from "node:fs";
import { shellQuote } from "@intentic/sandbox-run/quote";

// The offloaded-command wrapper (bin/offload-run). Off where it is not baked in, which leaves every line here.
export const OFFLOAD_RUN_BIN = "/usr/local/bin/offload-run";
export const offloadRunEnabled = (): boolean => existsSync(OFFLOAD_RUN_BIN);

// The label the check after landing runs under on a runner, beside the heavy-command rule ids an agent's lines carry.
export const LAND_CHECK_LABEL = "land-check";

// What goes in front of a heavy line whose kind the owner sends to a runner (settings `offload`): bin/offload-run, told
// the runner, the kind, the queue prefix it keeps for running the line here when the runner cannot take it, which of
// this environment's variables travel, and which come back as files.
export const offloadPrefix = (runner: string, label: string, queue: string, carry: readonly string[] = [], exports: readonly string[] = []): string =>
    [
        OFFLOAD_RUN_BIN,
        `--to ${shellQuote(runner)}`,
        `--label ${shellQuote(label)}`,
        `--here ${shellQuote(queue)}`,
        ...carry.map((name) => `--env ${shellQuote(name)}`),
        ...exports.map((name) => `--export ${shellQuote(name)}`),
        "-- ",
    ].join(" ");
