import { readFileSync } from "node:fs";
import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";
import { IGNORES, PROJECT_IGNORES } from "../ssh.js";

// What a project folder's sync leaves on the device, as one file both sides read: this agent, whose list is what sync
// actually does, and the desktop app (`_editor/desktop-app/src-tauri/src/project.rs` NOT_SYNCED), whose "Work on this
// with an agent" counts the folder without it and tells the owner what stays behind.
// SAFETY: the fixture is this repository's own file, written to this shape; one that drifted fails both cases below.
const FIXTURE = JSON.parse(readFileSync(new URL("../project-ignores.fixture.json", import.meta.url), "utf8")) as {
    readonly ignores: readonly string[];
};

test("a project folder's sync ignores exactly the shared list, in its order", () => {
    expect(PROJECT_IGNORES).toStrictEqual(FIXTURE.ignores);
});

test("the workspace's own session ignores the same list plus the state dir and the reference shelf, anchored at its root", () => {
    expect([...IGNORES].sort()).toStrictEqual([...FIXTURE.ignores, `/${STATE_DIR}`, `/${REFERENCE_DIR}`].sort());
});
