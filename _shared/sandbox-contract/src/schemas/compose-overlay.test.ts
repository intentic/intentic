import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { ComposedOverlayLineSchema } from "./compose-overlay.js";

// The lines a target image's composer prints, as examples: golden/compose-overlay.json, which ic's reader is held to
// (_sandbox/ic/src/sandbox/composition.rs). This is the TS half: each is a line the contract reads, its hash its overlay's.

interface ComposeCase {
    readonly name: string;
    readonly base: string;
    readonly line: unknown;
}

// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "compose-overlay.json"), "utf8")) as { readonly cases: readonly ComposeCase[] };

test("every golden line is a composer's line, its hash the overlay's own and its FROM the base it was asked for", () => {
    expect(GOLDEN.cases.length).toBeGreaterThan(2);
    for (const { base, line } of GOLDEN.cases) {
        const read = ComposedOverlayLineSchema.parse(line);
        expect(line).toEqual(read);
        if (read.overlay === null) {
            expect(read.hash).toBeUndefined();
            continue;
        }
        expect(read.hash).toBe(createHash("sha256").update(read.overlay).digest("hex"));
        expect(read.overlay).toContain(`\nFROM ${base}\n`);
    }
});

test("a line in another format is not one this contract reads", () => {
    expect(ComposedOverlayLineSchema.safeParse({ compose: 2, overlay: null }).success).toBe(false);
});
