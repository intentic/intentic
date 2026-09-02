import { expect, test } from "vitest";
import type { EngineState } from "./engine-store.js";
import { checks } from "./invariant.js";

/* The pointer and the directory are two records of one fact. The turn path reads the pointer, finds nothing
 * behind it, and quietly serves the image's copy, which is the failure this check exists to name. */

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (states: Readonly<Record<string, EngineState>>, disk: Readonly<Record<string, readonly string[]>>): Promise<void> => {
    const [check] = checks({
        engineState: async (id) => states[id] ?? { quarantined: [] },
        installedVersions: async (id) => [...(disk[id] ?? [])],
    });
    await check?.run({ moment: "sweep", fail });
};

test("a pointer onto an installed version reports nothing", async () => {
    await expect(run({ claude: { active: "2.1.0", quarantined: [] } }, { claude: ["2.1.0", "2.0.9"] })).resolves.toBeUndefined();
});

test("no pointer at all is the image's copy by design, not a finding", async () => {
    await expect(run({}, {})).resolves.toBeUndefined();
});

test("a pointer onto a version that is gone from disk is named, with what turns are actually running", async () => {
    await expect(run({ claude: { active: "2.1.0", quarantined: [] } }, { claude: ["2.0.9"] })).rejects.toThrow(/claude 2\.1\.0.*image's copy/);
});

test("an active version that is also quarantined is a contradiction the store cannot have written", async () => {
    await expect(
        run(
            { cursor: { active: "1.4.0", quarantined: [{ version: "1.4.0", reason: "would not launch", at: "2026-09-01T00:00:00Z" }] } },
            { cursor: ["1.4.0"] },
        ),
    ).rejects.toThrow(/cursor 1\.4\.0.*refused it and is serving it/);
});
