import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Decides which sandboxes may drive this device; upsertLink must merge, not overwrite (setup once dropped an existing
// link when connecting a second sandbox). homedir is stubbed, not the path parameterised, since the real path is
// computed at module load from agentHome; hence the dynamic import below.
let home: string;
let config: typeof import("./config.js");

const scopes = (shell: HostScopes["shell"]): HostScopes => ({
    shell,
    write: "off",
    screen: "off",
    control: "off",
    sandboxes: "off",
    sandboxRemove: "off",
    destructive: "off",
});

const link = (url: string, id: string, shell: HostScopes["shell"] = "off") => ({
    sandboxUrl: url,
    id,
    token: `token-for-${id}`,
    scopes: scopes(shell),
});

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "intentic-machine-config-"));
    vi.doMock("node:os", async () => ({ ...(await vi.importActual<typeof import("node:os")>("node:os")), homedir: () => home }));
    config = await import("./config.js");
});

afterAll(async () => {
    await rm(home, { recursive: true, force: true });
});

test("a device with nothing connected reads as an empty list, not as an error", async () => {
    expect(await config.readLinks()).toEqual([]);
});

test("connecting a second sandbox keeps the first", async () => {
    await config.upsertLink(link("https://one.example", "laptop"));
    const links = await config.upsertLink(link("https://two.example", "laptop"));
    expect(links.map((entry) => entry.sandboxUrl)).toEqual(["https://one.example", "https://two.example"]);
    expect(await config.readLinks()).toHaveLength(2);
});

test("re-running setup against a sandbox already connected rotates it in place rather than duplicating it", async () => {
    // Also covers what a token rotation, or a re-enrollment after a revoke, looks like from here.
    const links = await config.upsertLink({ ...link("https://one.example", "laptop"), token: "rotated" });
    expect(links.filter((entry) => entry.sandboxUrl === "https://one.example")).toHaveLength(1);
    expect(links.find((entry) => entry.sandboxUrl === "https://one.example")?.token).toBe("rotated");
});

test("scopes pushed by one sandbox do not touch another's", async () => {
    await config.rememberScopes("https://two.example", scopes("on"));
    const links = await config.readLinks();
    expect(links.find((entry) => entry.sandboxUrl === "https://two.example")?.scopes.shell).toBe("on");
    expect(links.find((entry) => entry.sandboxUrl === "https://one.example")?.scopes.shell).toBe("off");
});

test("scopes for a sandbox this device does not answer to are dropped, not written", async () => {
    await config.rememberScopes("https://never-connected.example", scopes("on"));
    expect((await config.readLinks()).map((entry) => entry.sandboxUrl)).toEqual(["https://two.example", "https://one.example"]);
});

test("disconnecting one sandbox leaves the others connected", async () => {
    const dropped = await config.removeLinks("https://two.example");
    expect(dropped.map((entry) => entry.sandboxUrl)).toEqual(["https://two.example"]);
    expect((await config.readLinks()).map((entry) => entry.sandboxUrl)).toEqual(["https://one.example"]);
});

test("disconnecting with no sandbox named drops every link", async () => {
    await config.upsertLink(link("https://three.example", "laptop"));
    const dropped = await config.removeLinks();
    expect(dropped).toHaveLength(2);
    expect(await config.readLinks()).toEqual([]);
});

test("the credential file is written so only this user can read it", async () => {
    await config.upsertLink(link("https://one.example", "laptop"));
    // The floor is @intentic/local-agent's; this only asserts the host agent actually goes through it.
    const { mode } = await import("node:fs/promises").then(async (fs) => await fs.stat(config.configPath));
    expect(mode & 0o077).toBe(0);
    // ...and that what landed matches the shape every reader expects.
    expect(JSON.parse(await readFile(config.configPath, "utf8"))).toEqual({
        links: [expect.objectContaining({ sandboxUrl: "https://one.example" })],
    });
});

/* THE STAMP THE RESIDENT LOOP LEAVES FOR `status`, whose whole point is that it AGES. The states it carries are
 * about sockets held in another process, so a stamp that outlives the loop that wrote it is worse than no stamp:
 * it would have `status` report a dead link as connected. What is asserted here is the boundary — inside the
 * window the stamp is the answer, outside it there is no answer at all. */
test("a machine whose agent never stamped its links has no answer, rather than a wrong one", async () => {
    // Runs before anything below writes a stamp: this is an agent too old to have the code, seen from here.
    expect(await config.readLinkStates()).toBeUndefined();
});

test("a stamp inside its window is the answer; past it, the loop that wrote it is presumed gone", async () => {
    const states = { "https://one.example": "open", "https://two.example": "connecting" } as const;
    await config.stampLinkStates(states);
    // The instant the writer recorded, read back from the stamp rather than sampled beside it: the boundary is
    // measured from that, and a millisecond spent writing the file would otherwise land a case on the wrong side.
    const { at } = JSON.parse(await readFile(config.linkStatePath, "utf8")) as { at: number };

    expect(await config.readLinkStates(at)).toEqual(states);
    expect(await config.readLinkStates(at + config.LINK_STAMP_STALE_MS)).toEqual(states);
    expect(await config.readLinkStates(at + config.LINK_STAMP_STALE_MS + 1)).toBeUndefined();
});

test("a stamp caught half-written reads as no answer, since the next one is seconds away", async () => {
    await writeFile(config.linkStatePath, '{"at":1700000000000,"links":{"https://one.exa');

    expect(await config.readLinkStates()).toBeUndefined();
});

test("the background-download switch defaults to on, and survives every link writer", async () => {
    // Same regression as the file header: a writer rebuilding from what it knows drops what it doesn't. The switch
    // shares the file with links, so each writer proves it passes the setting through.
    expect(await config.readPrepareUpdates()).toBe(true);
    await config.writePrepareUpdates(false);
    await config.upsertLink(link("https://four.example", "laptop"));
    expect(await config.readPrepareUpdates()).toBe(false);
    await config.rememberScopes("https://four.example", scopes("on"));
    expect(await config.readPrepareUpdates()).toBe(false);
    await config.removeLinks("https://four.example");
    expect(await config.readPrepareUpdates()).toBe(false);
    await config.writePrepareUpdates(true);
    expect(await config.readPrepareUpdates()).toBe(true);
});
