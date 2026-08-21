import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

import { createApp } from "../app.js";
import { hasSession, markConnected, sessionDir } from "../browser/session-store.js";

import {
    clientFor,
    collect,
    errorCode,
    fakeFiles,
    memoryCapabilitiesStore,
    memoryDismissalsStore,
    memoryPersonasStore,
    services,
    tempWorkspace,
} from "../route-testing.js";

/* The capabilities routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("capabilities.list reports each capability with its status; devops can't be removed, unknown is NOT_FOUND", async () => {
    // An isolated workspace, so the derived recommendations depend on this test's tree rather than on whatever
    // the machine running it happens to have checked out under /work.
    const client = clientFor(
        createApp(services({ workspace: tempWorkspace([]), capabilities: memoryCapabilitiesStore([{ id: "devops", kind: "devops", config: {} }]) })),
    );
    // devops status is derived from the repos on disk: absent under test, so it reads inactive.
    expect(await client.capabilities.list()).toEqual({
        // `secrets` names the credential keys an edit form must not treat as empty: devops holds none.
        capabilities: [{ id: "devops", kind: "devops", status: { state: "inactive" }, config: {}, secrets: [] }],
        recommendations: [],
    });
    // DevOps has no teardown (deleting the repos is data loss) → CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.remove({ id: "devops" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.remove({ id: "ghost" }))).toBe("NOT_FOUND");
});

// The whole point of deriving recommendations: a compose-backed dev database (`pnpm db:up`) fails with a bare
// "Cannot connect to the Docker daemon" against a sandbox whose engine is dormant, and nothing in that error
// names the capability. The list route is where the Capabilities page learns to badge it.
test("capabilities.list recommends docker when a repo in the workspace carries a compose file", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    writeFileSync(join(workspace.root, "app", "docker-compose.yml"), "");
    const client = clientFor(createApp(services({ workspace, capabilities: memoryCapabilitiesStore([]) })));
    expect((await client.capabilities.list()).recommendations).toEqual([
        { card: "docker", evidence: "app/docker-compose.yml", reason: "your workspace has a compose stack to run", prefill: {} },
    ]);
});

// "Not needed" is the other half of making suggestions at all: a surface that re-derives them on every load and
// cannot be told no becomes the strip people stop reading. The evidence is recorded daemon-side, so the record
// answers the claim that was on screen rather than whatever the client chose to send.
test("capabilities.dismiss takes a recommendation off the catalog and records what it was declined against", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    writeFileSync(join(workspace.root, "app", "docker-compose.yml"), "");
    const dismissals = memoryDismissalsStore();
    const client = clientFor(createApp(services({ workspace, capabilities: memoryCapabilitiesStore([]), capabilityDismissals: dismissals })));
    expect(await client.capabilities.dismiss({ card: "docker" })).toEqual({ ok: true });
    expect(await dismissals.list()).toEqual([{ card: "docker", evidence: "app/docker-compose.yml" }]);
    expect((await client.capabilities.list()).recommendations).toEqual([]);
    // Nothing is being suggested for a card nobody was offered: there is no claim to record a "no" against.
    expect(await errorCode(client.capabilities.dismiss({ card: "github" }))).toBe("NOT_FOUND");
});

/* RENAMING IS A MIGRATION, and this is the case that proves why it can't be an add plus a remove: the identity's
 * logged-in browser has to arrive at the new name, and the account living in that browser has to still know
 * whose it is. A remove would have deleted the profile (signing every account in it out) and left the account
 * pointing at a name nothing answers to. */
test("capabilities.rename carries the browser profile and repoints everything that named the old id", async () => {
    const workspace = tempWorkspace([]);
    const personas = memoryPersonasStore([{ id: "front", capabilities: ["me", "reddit"] }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                personas,
                capabilities: memoryCapabilitiesStore([
                    { id: "me", kind: "identity", config: { email: "ada@example.com", openAccounts: "off" } },
                    { id: "reddit", kind: "browser", config: { platform: "reddit", identity: "me" } },
                ]),
            }),
        ),
    );
    // The finished sign-in, which is the thing worth carrying: a marker beside a profile directory.
    await markConnected(workspace.root, "me");
    mkdirSync(sessionDir(workspace.root, "me"), { recursive: true });

    expect(await client.capabilities.rename({ id: "me", to: "ada" })).toEqual({ ok: true });

    const { capabilities } = await client.capabilities.list();
    expect(capabilities.map((capability) => capability.id).toSorted()).toEqual(["ada", "reddit"]);
    // The account still lives in that identity's browser, and the persona still speaks through both.
    expect(capabilities.find((capability) => capability.id === "reddit")?.config["identity"]).toBe("ada");
    expect((await personas.get("front"))?.capabilities).toEqual(["ada", "reddit"]);
    // Still signed in, under the new name: profile and marker both followed.
    expect(hasSession(workspace.root, "ada")).toBe(true);
    expect(hasSession(workspace.root, "me")).toBe(false);
    expect(existsSync(sessionDir(workspace.root, "ada"))).toBe(true);
});

test("capabilities.rename refuses a name already in use, an unknown connection, and a kind whose name isn't its own", async () => {
    const client = clientFor(
        createApp(
            services({
                workspace: tempWorkspace([]),
                capabilities: memoryCapabilitiesStore([
                    { id: "docker", kind: "docker", config: { gpu: "off" } },
                    { id: "notes", kind: "mcp", config: { url: "https://notes.example.com/mcp" } },
                    { id: "tasks", kind: "mcp", config: { url: "https://tasks.example.com/mcp" } },
                ]),
            }),
        ),
    );
    expect(await errorCode(client.capabilities.rename({ id: "notes", to: "tasks" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.rename({ id: "ghost", to: "spirit" }))).toBe("NOT_FOUND");
    // The engine is part of the sandbox rather than a connection somebody named: its handler says so.
    expect(await errorCode(client.capabilities.rename({ id: "docker", to: "containers" }))).toBe("CONFLICT");
    // A name the add form would refuse never reaches a handler: the wire schema is the same rule.
    expect(await errorCode(client.capabilities.rename({ id: "notes", to: "-nope" }))).toBe("BAD_REQUEST");
});

test("capabilities.add composes the entry's image fragment into the overlay and nags for the rebuild; remove drops it", async () => {
    const disk = new Map<string, string>();
    const memoryFiles = fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, content as string);
        },
        remove: async (path) => {
            disk.delete(path);
        },
    });
    // The vpn handler writes ~/.wireguard on the real fs: point HOME at a temp dir like vpn.integration.test.ts.
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "app-vpn-home-"));
    const client = clientFor(createApp(services({ files: memoryFiles, capabilities: memoryCapabilitiesStore() })));

    const events = await collect(
        // auto-connect on: with no VPN tooling installed yet, the apply must still land in the manifest and say
        // a rebuild is what installs the client: the pre-rebuild bootstrap this whole flow depends on.
        await client.capabilities.add({
            id: "office",
            kind: "vpn",
            config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
        }),
    );
    expect(events.some((event) => "message" in event && typeof event["message"] === "string" && event["message"].includes("rebuild"))).toBe(true);
    const approvedFile = disk.get("/work/.intentic/local/environment.approved.Dockerfile");
    expect(approvedFile).toContain("wireguard-tools");
    expect(approvedFile).toContain("# intentic:runtime --device=/dev/net/tun");

    // Removing the last fragment-bearing capability recomposes the overlay away (stock container, no custom).
    await client.capabilities.remove({ id: "office" });
    expect(disk.get("/work/.intentic/local/environment.approved.Dockerfile")).toBeUndefined();
});

/* CHANGING A CONNECTION WITHOUT RE-TYPING WHAT IT IS SIGNED IN WITH: the whole point of the marker.
 *
 * A tunnel's WireGuard conf is a credential, so it is never sent to the browser; every other answer is. Editing
 * one therefore means posting back a config with a hole where the credential goes, and the two obvious spellings
 * of that hole are both wrong: an empty string is a config that fails to dial, and an absent key fails the
 * schema. VAULTED is the third, and this pins what it costs: the tunnel keeps dialling with the key it had,
 * and the answer that WAS changed is the one that changed.
 *
 * The refusal is half the test. A marker with nothing behind it means the sender believed a credential was
 * stored and none is, and a daemon that let it through would write the literal marker into a conf file and fail
 * at dial time, somewhere with no way to say which box to go back and fill in. */
test("capabilities.add keeps a credential the sender never saw, and refuses to keep one that isn't there", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "app-vpn-edit-home-"));
    const disk = new Map<string, string>();
    const memoryFiles = fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, content as string);
        },
        remove: async (path) => {
            disk.delete(path);
        },
    });
    const store = memoryCapabilitiesStore();
    const client = clientFor(createApp(services({ files: memoryFiles, capabilities: store })));
    const conf = "[Interface]\nPrivateKey = REAL\n";
    // `add` streams, so its refusal arrives on the iteration rather than on the call: both are awaited here.
    const addFailure = (input: Parameters<typeof client.capabilities.add>[0]): Promise<string | undefined> =>
        errorCode((async () => collect(await client.capabilities.add(input)))());

    await collect(await client.capabilities.add({ id: "office", kind: "vpn", config: { provider: "wireguard", config: conf, autoConnect: "on" } }));
    // What a browser is told it holds: the shape, and the NAMES of the credentials in it, never the values.
    const [listed] = (await client.capabilities.list()).capabilities;
    expect(listed?.config).toEqual({ provider: "wireguard", autoConnect: "on" });
    expect(listed?.secrets).toEqual(["config"]);

    // The edit: one answer changed, the credential kept.
    await collect(
        await client.capabilities.add({ id: "office", kind: "vpn", config: { provider: "wireguard", config: VAULTED, autoConnect: "off" } }),
    );
    expect((await store.get("office"))?.config).toEqual({ provider: "wireguard", config: conf, autoConnect: "off" });

    // Nothing stored behind the marker: a fresh id has no credential to keep.
    expect(await addFailure({ id: "fresh", kind: "vpn", config: { provider: "wireguard", config: VAULTED } })).toBe("BAD_REQUEST");
});
