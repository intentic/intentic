import { MEMORY_FILE } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import { vocabularyFor } from "../../../core-views/vocabulary";
import { specialChip } from "./specialPaths";

// A role the sandbox enforces and the name doesn't state: the chip is the only place the tree says so.

const developer = vocabularyFor(`developer`);
const maker = vocabularyFor(`maker`);

test("the reserved top-level folders are marked, and a repo's own folders of the same name are not", () => {
    expect(specialChip(REFERENCE_DIR, developer)).toMatchObject({ label: `reference`, tone: `subtle` });
    // The outbox is the one warning: what lands there is on the open internet.
    expect(specialChip(PUBLIC_DIR, developer)).toMatchObject({ label: `public`, tone: `warning` });

    expect(specialChip(`app/${PUBLIC_DIR}`, developer)).toBeUndefined();
    expect(specialChip(`app/${REFERENCE_DIR}`, developer)).toBeUndefined();
});

test("a memory file is marked wherever it sits, since a conversation starting there is told it", () => {
    expect(specialChip(MEMORY_FILE, developer)).toMatchObject({ label: `memory` });
    expect(specialChip(`shop/${MEMORY_FILE}`, developer)).toMatchObject({ label: `memory` });
    // Not a memory file: the match is the whole name, not a suffix of one.
    expect(specialChip(`shop/MY-${MEMORY_FILE}`, developer)).toBeUndefined();
});

test("an ordinary file wears nothing", () => {
    expect(specialChip(`README.md`, developer)).toBeUndefined();
    expect(specialChip(`src/index.ts`, developer)).toBeUndefined();
});

test("every chip says what the role is, not just that there is one", () => {
    expect([REFERENCE_DIR, PUBLIC_DIR, MEMORY_FILE].map((path) => specialChip(path, developer)?.tooltip)).toEqual([
        { title: `Reference only`, note: `No search, setup, sync` },
        { title: `Open internet`, tone: `warn`, note: `No sign-in` },
        { title: `Standing instructions`, note: `Every turn from here` },
    ]);
    expect([REFERENCE_DIR, PUBLIC_DIR, MEMORY_FILE].map((path) => specialChip(path, maker)?.tooltip)).toEqual([
        { title: `Reference only`, note: `No search, setup, sync` },
        { title: `Anyone with link`, tone: `warn`, note: `No sign-in` },
        { title: `Standing instructions`, note: `Every chat from here` },
    ]);
});

test("the same role wears the audience's own word, with the warning tone kept either way", () => {
    expect(specialChip(PUBLIC_DIR, maker)).toMatchObject({ label: maker.publicChip, tone: `warning` });
    expect(specialChip(MEMORY_FILE, maker)?.label).toBe(maker.memoryChip);
    expect(specialChip(MEMORY_FILE, maker)?.label).not.toBe(specialChip(MEMORY_FILE, developer)?.label);
});
