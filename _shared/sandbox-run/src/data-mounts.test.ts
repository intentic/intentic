import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DATA_MOUNTS, SANDBOX_VOLUMES } from "./index.js";

// ic cannot import this package, so it keeps copies of DATA_MOUNTS (_sandbox/ic/src/sandbox/preflight.rs) and of the
// volumes' destinations (storage.rs), and its tests hold each copy to a golden file here. A change to a list that its
// file does not carry fails here, naming it; `INTENTIC_WRITE_GOLDEN=1` rewrites them, and the Rust tests then say
// whether ic's copies still agree.

// The golden file's text and the text the list would write, rewriting the file first when asked to.
const golden = (name: string, value: unknown) => {
    const path = join(packageRoot(import.meta.url), "golden", name);
    const expected = `${JSON.stringify(value, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(path, expected);
    }
    return { onDisk: readFileSync(path, "utf8"), expected };
};

test("golden/data-mounts.json is the run contract's list of data mounts", () => {
    const { onDisk, expected } = golden("data-mounts.json", DATA_MOUNTS);
    expect(onDisk).toBe(expected);
});

test("golden/volumes.json is where the run contract mounts each named volume", () => {
    const { onDisk, expected } = golden(
        "volumes.json",
        SANDBOX_VOLUMES.map(({ destination }) => destination),
    );
    expect(onDisk).toBe(expected);
});
