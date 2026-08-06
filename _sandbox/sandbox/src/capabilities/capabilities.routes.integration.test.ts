import { mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import {
    clientFor,
    collect,
    errorCode,
    fakeFiles,
    memoryCapabilitiesStore,
    memoryDismissalsStore,
    services,
    tempWorkspace,
} from "../route-testing.js";

/* The capabilities routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("capabilities.list reports each capability with its status; devops can't be removed, unknown is NOT_FOUND", async () => {
    // An isolated workspace, so the derived recommendations depend on this test's tree rather than on whatever
    // the machine running it happens to have checked out under /work.
    const client = clientFor(
        createApp(services({ workspace: tempWorkspace([]), capabilities: memoryCapabilitiesStore([{ id: "devops", kind: "devops", config: {} }]) })),
    );
    // devops status is derived from the repos on disk — absent under test, so it reads inactive.
    expect(await client.capabilities.list()).toEqual({
        capabilities: [{ id: "devops", kind: "devops", status: { state: "inactive" }, config: {} }],
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
    // Nothing is being suggested for a card nobody was offered — there is no claim to record a "no" against.
    expect(await errorCode(client.capabilities.dismiss({ card: "github" }))).toBe("NOT_FOUND");
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
    // The vpn handler writes ~/.wireguard on the real fs — point HOME at a temp dir like vpn.integration.test.ts.
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "app-vpn-home-"));
    const client = clientFor(createApp(services({ files: memoryFiles, capabilities: memoryCapabilitiesStore() })));

    const events = await collect(
        // auto-connect on: with no VPN tooling installed yet, the apply must still land in the manifest and say
        // a rebuild is what installs the client — the pre-rebuild bootstrap this whole flow depends on.
        await client.capabilities.add({
            id: "office",
            kind: "vpn",
            config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
        }),
    );
    expect(events.some((event) => "message" in event && typeof event["message"] === "string" && event["message"].includes("rebuild"))).toBe(true);
    const approvedFile = disk.get("/work/.intentic/environment.approved.Dockerfile");
    expect(approvedFile).toContain("wireguard-tools");
    expect(approvedFile).toContain("# intentic:runtime --device=/dev/net/tun");

    // Removing the last fragment-bearing capability recomposes the overlay away (stock container, no custom).
    await client.capabilities.remove({ id: "office" });
    expect(disk.get("/work/.intentic/environment.approved.Dockerfile")).toBeUndefined();
});
