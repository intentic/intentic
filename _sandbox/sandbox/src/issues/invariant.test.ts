import { expect, test } from "vitest";
import { checks } from "./invariant.js";
import type { IssuesStore } from "./issues-store.js";

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (invalid: readonly string[]): Promise<void> => {
    const issues = { list: async () => ({ issues: [], invalid: [...invalid] }) } as unknown as IssuesStore;
    const [check] = checks({ issues });
    await check?.run({ moment: "sweep", fail });
};

test("an inbox whose every file parses reports nothing", async () => {
    await expect(run([])).resolves.toBeUndefined();
});

test("a file the store refused is named, and read as the daemon's own fault", async () => {
    // The store is the only writer, so the message must not hedge: it is a daemon bug or a damaged volume.
    await expect(run(["3f9a1c2b4d5e6f70.json"])).rejects.toThrow(/3f9a1c2b4d5e6f70\.json.*only writer/);
});
