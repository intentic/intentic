import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DATA_MOUNTS } from "./index.js";

// ic cannot import this package, so it keeps a copy of DATA_MOUNTS, and its test (_sandbox/ic/src/sandbox/preflight.rs)
// holds that copy to this golden file. A change to the list that the file does not carry fails here, naming it;
// `INTENTIC_WRITE_GOLDEN=1` rewrites it, and the Rust test then says whether ic's copy still agrees.

test("golden/data-mounts.json is the run contract's list of data mounts", () => {
    const path = join(packageRoot(import.meta.url), "golden", "data-mounts.json");
    const expected = `${JSON.stringify(DATA_MOUNTS, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(path, expected);
    }
    expect(readFileSync(path, "utf8")).toBe(expected);
});
