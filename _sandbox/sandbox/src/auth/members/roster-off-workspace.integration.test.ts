import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { pino } from "pino";
import { testConfig } from "../../testing.js";
import { createAuthSlice } from "../auth-slice.js";

// Who may reach this sandbox, who owns it and which programs hold a token are the daemon's to decide, and every turn
// writes the workspace as freely as its person does: a roster there let any member's agent (or a prompt that steered
// one) grant its person the maintainer tier, bind an owner, or plant a token of its own. Written at the addresses the
// workspace used to hold them, those files are now nobody's input.

const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
};

test("a turn writing the workspace's identity files changes nobody's access", async () => {
    const base = mkdtempSync(join(tmpdir(), "roster-off-workspace-"));
    const workspaceRoot = join(base, "work");
    const slice = createAuthSlice({ ...testConfig, historyRoot: join(base, "history") }, workspaceRoot, pino({ level: "silent" }));
    const identity = join(workspaceRoot, ".intentic", "identity");

    await put(join(identity, "members.json"), { members: [{ email: "mallory@example.com", role: "maintainer" }] });
    await put(join(identity, "owner.json"), { email: "mallory@example.com" });
    await put(join(identity, "control-tokens.json"), {
        tokens: [{ id: "planted", label: "planted", scope: "land", hash: sha256Hex("ict_planted"), createdAt: 0 }],
    });

    expect(await slice.members.list()).toEqual([]);
    expect(await slice.ownerEmail()).toBeUndefined();
    expect(await slice.controlTokens.resolve("ict_planted")).toBeUndefined();
});
