import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

/* THE FILE THAT DECIDES WHICH SANDBOXES MAY DRIVE THIS COMPUTER, and the one regression worth pinning.
 *
 * `setup` used to write this file wholesale, so connecting a computer to a second sandbox silently disconnected
 * it from the first. That is not an exotic path: the last step of onboarding runs `intentic-machine computer setup`, so
 * setting up a NEW sandbox on a computer that already had one took the computer away from the old one — with
 * no prompt, nothing about it on the progress screen, and every scope on the replacement starting `off`. It was
 * found by doing it: a machine dropped off its owner's sandbox mid-install and had to be re-paired by hand.
 *
 * `homedir` is stubbed rather than the config path parameterised, because the path is the thing under test: the
 * real one is computed once at module load from `agentHome("host")`, and a test that passed its own path would
 * be exercising a different function from the one that runs on somebody's machine. Hence the dynamic import
 * below — the mock has to be in place before the module body runs. */
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

test("a computer with nothing connected reads as an empty list, not as an error", async () => {
    expect(await config.readLinks()).toEqual([]);
});

test("connecting a second sandbox keeps the first", async () => {
    await config.upsertLink(link("https://one.example", "laptop"));
    const links = await config.upsertLink(link("https://two.example", "laptop"));
    expect(links.map((entry) => entry.sandboxUrl)).toEqual(["https://one.example", "https://two.example"]);
    expect(await config.readLinks()).toHaveLength(2);
});

test("re-running setup against a sandbox already connected rotates it in place rather than duplicating it", async () => {
    // Which is what a token rotation and a re-enrollment after a revoke both look like from here.
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

test("scopes for a sandbox this computer does not answer to are dropped, not written", async () => {
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
    // The token in here is a durable grant to somebody's sandbox; the floor belongs to @intentic/local-agent
    // and this asserts the host agent actually goes through it.
    const { mode } = await import("node:fs/promises").then(async (fs) => await fs.stat(config.configPath));
    expect(mode & 0o077).toBe(0);
    // …and that what landed is the list shape every reader above expects.
    expect(JSON.parse(await readFile(config.configPath, "utf8"))).toEqual({
        links: [expect.objectContaining({ sandboxUrl: "https://one.example" })],
    });
});
