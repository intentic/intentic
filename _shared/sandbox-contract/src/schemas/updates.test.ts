import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { PreparingUpdateSchema } from "./system.js";
import { UpdateOutcomeSchema } from "./updates.js";

// The update markers `ic` writes onto /history for the daemon to read, spelled once here: golden/update-outcome.json
// and golden/update-preparing.json are these examples as JSON, and ic's Rust test (_sandbox/ic/src/sandbox/host_files.rs)
// holds what it writes to them field for field. Where each file lives is the daemon's to say (its own golden,
// host-files.json). A change here that the committed file does not carry fails, naming the file;
// `INTENTIC_WRITE_GOLDEN=1` rewrites them, and the Rust test then says whether ic still writes them.

const GOLDEN = join(packageRoot(import.meta.url), "golden");

// Every field set, and the result whose spelling is easiest to get wrong.
const outcome = UpdateOutcomeSchema.parse({
    result: "rolled-back",
    verb: "update",
    at: 1_791_240_330_000,
    from: "1.399.0",
    to: "1.400.0",
    reason: "the new version's daemon kept crashing (3 restarts)",
    log: "/home/owner/.intentic/logs/update-sandbox-0123456789ab.log",
    keepUntil: 1_791_326_730_000,
});

const preparing = PreparingUpdateSchema.parse({
    channel: "stable",
    startedAt: 1_791_240_300_000,
    at: 1_791_240_330_000,
    phase: "download",
    percent: 42,
});

const goldens = [
    { file: "update-outcome.json", value: outcome },
    { file: "update-preparing.json", value: preparing },
];

test.each(goldens)("golden/$file is the contract's example, as the host writes it", ({ file, value }) => {
    const path = join(GOLDEN, file);
    const expected = `${JSON.stringify(value, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(path, expected);
    }
    expect(readFileSync(path, "utf8")).toBe(expected);
});
