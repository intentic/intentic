import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { EGRESS_PRIVATE_V4, EGRESS_PRIVATE_V6 } from "./egress.js";

// ic renders these ranges into its nftables rules (_sandbox/ic/src/sandbox/egress/render.rs), and its Rust test reads the
// same golden, so a range added here and not there fails one side or the other instead of fencing differently.
// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "egress-private.json"), "utf8")) as {
    readonly v4: string[];
    readonly v6: string[];
};

test("the private ranges internet-only refuses are the ones ic renders", () => {
    expect([...EGRESS_PRIVATE_V4]).toEqual(GOLDEN.v4);
    expect([...EGRESS_PRIVATE_V6]).toEqual(GOLDEN.v6);
});
