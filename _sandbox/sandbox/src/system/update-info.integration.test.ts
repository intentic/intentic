import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import { clientFor } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../testing.js";
import { refreshReleaseNotes } from "./updates/release-notes.js";
import { refreshLatestVersion } from "./updates/version-check.js";

// What /info says about this sandbox's version beyond the version itself: what the host last did about it, a release the
// owner skipped, and whether the running release was withdrawn. Its own file, since the release caches it fills are
// module state every later /info in the same file would read.

afterEach(() => {
    unstubAllGlobals();
});

const RUNNING = "1.52.0";

const sandbox = () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "update-info-"));
    const client = clientFor(
        createApp(services({ config: { ...testConfig, historyRoot }, info: { name: "intentic-sandbox", image: "ghcr.io/intentic/sandbox:stable", version: RUNNING } })),
    );
    return { historyRoot, client };
};

// GitHub, answering the newest release and the page of recent ones, and the registry, whose `:stable` already names
// that release's image: a release is offered only once it is there (version-check.ts).
const github = (latest: string, releases: readonly unknown[] = []): void => {
    stubGlobal("fetch", async (url: string | URL) => {
        const address = String(url);
        if (address.endsWith("/releases/latest")) {
            return new Response(JSON.stringify({ tag_name: `v${latest}` }), { status: 200 });
        }
        if (address.includes("ghcr.io/token")) {
            return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });
        }
        if (address.includes("ghcr.io/v2/")) {
            return new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${latest}` } });
        }
        return new Response(JSON.stringify(releases), { status: 200 });
    });
};

test("what the host last did about the version is passed on as it wrote it, and nothing when it wrote nothing", async () => {
    const { historyRoot, client } = sandbox();
    expect(await client.system.info()).not.toHaveProperty("lastUpdate");

    const outcome = { result: "rolled-back", verb: "probation", at: 1_790_000_000_000, from: "1.52.0", to: "1.53.0", reason: "it never became ready" };
    writeFileSync(join(historyRoot, "update-outcome.json"), JSON.stringify(outcome));
    expect(await client.system.info()).toMatchObject({ version: RUNNING, lastUpdate: outcome });
});

test("a skipped release is not offered while it is the newest, a newer one is, and clearing the skip offers it again", async () => {
    const { client } = sandbox();
    github("1.53.0");
    await refreshLatestVersion();
    expect(await client.system.info()).toMatchObject({ latest: "1.53.0", updateAvailable: true });

    expect(await client.system.skipUpdate({ version: "v1.53.0" })).toEqual({ ok: true });
    expect(await client.system.info()).toMatchObject({ latest: "1.53.0", updateAvailable: false, skippedVersion: "1.53.0" });

    github("1.54.0");
    await refreshLatestVersion();
    expect(await client.system.info()).toMatchObject({ latest: "1.54.0", updateAvailable: true, skippedVersion: "1.53.0" });

    github("1.53.0");
    await refreshLatestVersion();
    await client.system.skipUpdate({ version: null });
    const info = await client.system.info();
    expect(info).toMatchObject({ latest: "1.53.0", updateAvailable: true });
    expect(info).not.toHaveProperty("skippedVersion");
});

test("a sandbox running a withdrawn release is told so and why, and the withdrawn release's notes are nobody's update notes", async () => {
    const { client } = sandbox();
    github("1.51.0", [
        { tag_name: "v1.53.0", body: "## What's new\n\n- The fix.\n" },
        { tag_name: `v${RUNNING}`, body: "Withdrawn: it lost conversations on boot\n\n## What's new\n\n- The bad thing.\n", prerelease: true },
    ]);
    await refreshReleaseNotes();

    const info = await client.system.info();
    expect(info).toMatchObject({ withdrawn: { version: RUNNING, reason: "it lost conversations on boot" }, updateNotes: ["The fix."] });
});
