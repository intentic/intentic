import { MEMORY_FILE } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import { expect, test } from "vitest";
import { specialChip } from "./specialPaths";

// A role the sandbox enforces and the name doesn't state: the chip is the only place the tree says so.

test("the reserved top-level folders are marked, and a repo's own folders of the same name are not", () => {
    expect(specialChip(REFERENCE_DIR)).toMatchObject({ label: `reference`, tone: `subtle` });
    // The outbox is the one warning: what lands there is on the open internet.
    expect(specialChip(PUBLIC_DIR)).toMatchObject({ label: `public`, tone: `warning` });

    expect(specialChip(`app/${PUBLIC_DIR}`)).toBeUndefined();
    expect(specialChip(`app/${REFERENCE_DIR}`)).toBeUndefined();
});

test("a memory file is marked wherever it sits, since a conversation starting there is told it", () => {
    expect(specialChip(MEMORY_FILE)).toMatchObject({ label: `memory` });
    expect(specialChip(`shop/${MEMORY_FILE}`)).toMatchObject({ label: `memory` });
    // Not a memory file: the match is the whole name, not a suffix of one.
    expect(specialChip(`shop/MY-${MEMORY_FILE}`)).toBeUndefined();
});

test("an ordinary file wears nothing", () => {
    expect(specialChip(`README.md`)).toBeUndefined();
    expect(specialChip(`src/index.ts`)).toBeUndefined();
});

test("every chip says what the role is, not just that there is one", () => {
    for (const path of [REFERENCE_DIR, PUBLIC_DIR, MEMORY_FILE]) {
        expect(specialChip(path)?.tooltip.length).toBeGreaterThan(30);
    }
});
