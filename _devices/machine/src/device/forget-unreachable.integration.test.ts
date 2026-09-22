import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { LONG_OUTAGE_ATTEMPTS } from "@intentic/sandbox-contract/peer-dial";
import { afterAll, beforeAll, beforeEach, expect, test, mock } from "bun:test";
import * as osOriginal from "node:os";
import * as residentOriginal from "../resident.js";

// Dropping the links a machine can no longer reach: the one delete on this device driven from a sandbox, so what it is
// allowed to act on is the whole subject. It deletes ONLY on live evidence — the resident agent's own stamp — because
// the alternative reading of "this config lists a sandbox I cannot reach" is "my agent isn't running", and that one
// costs the user every link they have. homedir is stubbed the way config.integration.test.ts stubs it; residency is
// stubbed because reconciling it spawns a real agent.
let home: string;
let commands: typeof import("./commands.js");
let config: typeof import("./config.js");
const reconciled = mock<(log: (message: string) => void) => Promise<void>>();

const scopes: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off" };

const link = (url: string) => ({ sandboxUrl: url, id: `device-for-${url}`, token: `token-for-${url}`, scopes });

// One outage old enough to be gone, at the threshold the dial loop itself draws.
const gone = (since: number) => ({ state: "connecting", outage: { failures: LONG_OUTAGE_ATTEMPTS, since } }) as const;

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "intentic-machine-forget-"));
    mock.module("node:os", () => ({ ...osOriginal, homedir: () => home }));
    mock.module("../resident.js", () => ({ ...residentOriginal, reconcileResidency: reconciled }));
    config = await import("./config.js");
    commands = await import("./commands.js");
});

afterAll(async () => {
    await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
    reconciled.mockClear();
    await config.removeLinks();
    await rm(config.linkStatePath, { force: true });
});

// The self-destruct this whole change exists to stop, in its last remaining form: with no live reading, "unreachable"
// is unknowable, and a drop that guessed would disconnect a machine whose agent had merely been stopped.
test("a machine whose agent is not stamping drops nothing at all", async () => {
    await config.upsertLink(link("https://one.example"));
    const said: string[] = [];

    await commands.dropUnreachableLinks((message) => said.push(message));

    expect((await config.readLinks()).map((entry) => entry.sandboxUrl)).toEqual(["https://one.example"]);
    expect(reconciled).not.toHaveBeenCalled();
    expect(said.join(" ")).toContain("isn't running");
});

test("every link answering is an answer, not a reason to delete one", async () => {
    await config.upsertLink(link("https://one.example"));
    await config.stampLinkStates({ "https://one.example": { state: "open" } });
    const said: string[] = [];

    await commands.dropUnreachableLinks((message) => said.push(message));

    expect((await config.readLinks()).map((entry) => entry.sandboxUrl)).toEqual(["https://one.example"]);
    expect(reconciled).not.toHaveBeenCalled();
    expect(said.join(" ")).toContain("Nothing dropped.");
});

test("only the links that stopped answering go, and the agent is restarted against what is left", async () => {
    await config.upsertLink(link("https://open.example"));
    await config.upsertLink(link("https://gone.example"));
    await config.upsertLink(link("https://blipping.example"));
    await config.stampLinkStates({
        "https://open.example": { state: "open" },
        "https://gone.example": gone(1_700_000_000_000),
        // One attempt short of the threshold: a sandbox that is restarting, not one that is gone.
        "https://blipping.example": { state: "connecting", outage: { failures: LONG_OUTAGE_ATTEMPTS - 1, since: 1_700_000_000_000 } },
    });
    const said: string[] = [];

    await commands.dropUnreachableLinks((message) => said.push(message));

    expect((await config.readLinks()).map((entry) => entry.sandboxUrl)).toEqual(["https://open.example", "https://blipping.example"]);
    // Or the dial loops for the links just deleted keep running inside the agent that is already up.
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect(said.join(" ")).toContain("https://gone.example");
    expect(said.join(" ")).toContain("Still connected to 2 sandboxes.");
});

// The background-download switch shares the file with the links, so the drop is held to the same rule every other
// writer here is: rebuild from what you read, not from what you know.
test("the drop leaves the rest of the config alone", async () => {
    await config.upsertLink(link("https://gone.example"));
    await config.writePrepareUpdates(false);
    await config.stampLinkStates({ "https://gone.example": gone(1_700_000_000_000) });

    await commands.dropUnreachableLinks(() => undefined);

    expect(await config.readLinks()).toEqual([]);
    expect(await config.readPrepareUpdates()).toBe(false);
});
