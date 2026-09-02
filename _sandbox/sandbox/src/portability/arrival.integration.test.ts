import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { expect, test } from "vitest";
import { pack } from "tar-stream";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createArrivals } from "./arrival.js";
import { packBundle } from "./bundle.js";

/* ONE PICKER, EVERY FORMAT — the claim the arrival pipeline exists to make, tested where it is decided.
 *
 * Three surfaces once: a definition had its own route, a bundle another, a foreign assistant a third, and the
 * browser had to know which of the three it was holding before it could hand it over. It does not any more:
 * the daemon reads two bytes and, when they say gzip, the tar's first entry name. This suite is that
 * disambiguation, with a REAL artifact of each kind rather than a hand-written header, because the whole risk
 * of sniffing is that it works on fixtures and not on what the exporters actually emit.
 */

const roots: string[] = [];
const makeRoots = async (): Promise<{ work: string; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-arrival-"));
    roots.push(dir);
    const work = join(dir, "work");
    const history = join(dir, "history");
    await mkdir(work, { recursive: true });
    await mkdir(history, { recursive: true });
    return { work, history };
};

const cleanup = async (): Promise<void> => {
    for (const dir of roots.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
};

const LIMIT = 64 * 1024 * 1024;

const servicesFor = (paths: { work: string; history: string }) =>
    services({
        workspace: workspacePaths(paths.work),
        config: { ...testConfig, workspaceRoot: paths.work, historyRoot: paths.history },
        capabilities: memoryCapabilitiesStore([]),
        files: fakeFiles({ read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined) }),
        vaultManifestSecrets: async () => [],
        vaultExtensionSettingSecrets: async () => [],
    } as Parameters<typeof services>[0]);

const streamOf = (text: string): ReadableStream<Uint8Array> => new Blob([text]).stream();

// A real bundle, out of the real packer, so the sniff meets the bytes production emits.
const realBundle = async (): Promise<ReadableStream<Uint8Array>> => {
    const source = await makeRoots();
    await writeFile(join(source.work, "notes.md"), "# hello\n");
    const stream = packBundle(servicesFor(source), { secrets: false, now: 1_700_000_000_000 });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    return new Blob(chunks.map((chunk) => new Uint8Array(chunk))).stream();
};

// A packed foreign home, the way the card's own instructions tell people to make one.
const hermesHome = (): ReadableStream<Uint8Array> => {
    const packer = pack();
    packer.entry({ name: ".hermes/config.yaml", type: "file" }, "mcp_servers:\n  linear:\n    url: https://mcp.linear.app/sse\n");
    packer.entry({ name: ".hermes/SOUL.md", type: "file" }, "Be warm.");
    packer.finalize();
    return Readable.toWeb(packer.pipe(createGzip())) as ReadableStream<Uint8Array>;
};

const DEFINITION = ["schemaVersion = 1", 'name = "somewhere-else"', "", "[settings]", "workspaceMap = true", ""].join("\n");

test("one picker reads all three formats, and says which it found", async () => {
    const arrivals = createArrivals(servicesFor(await makeRoots()));

    // Not gzip ⇒ a document. The name rides through to the checklist's badge.
    const definition = await arrivals.plan(streamOf(DEFINITION), LIMIT);
    expect(definition.source).toBe("definition");
    expect(definition.name).toBe("somewhere-else");
    // A definition carries secret NAMES and never a value, so the second consent is not even a question.
    expect(definition.carriesSecrets).toBe(false);

    // Gzip whose first tar entry is our manifest ⇒ a bundle, with a row per thing in it.
    const bundle = await arrivals.plan(await realBundle(), LIMIT);
    expect(bundle.source).toBe("bundle");
    expect(bundle.items.map((item) => item.id)).toContain("bundle:files");

    // Gzip that is any other tar ⇒ somebody's home directory, recognized by its anchor file.
    const hermes = await arrivals.plan(hermesHome(), LIMIT);
    expect(hermes.source).toBe("hermes");
    expect(hermes.items.some((item) => item.group === "memory")).toBe(true);

    await cleanup();
});

/* ONE HELD ARRIVAL AT A TIME, ACROSS FORMATS, which is the property that made a single pipeline worth having
 * rather than three that each happened to hold their own: reading a second artifact must retire the first,
 * whatever kinds they were, or a token minted for a Hermes folder could apply against a spooled bundle. */
test("a second read retires the first, whatever the two formats were, and drops its spool", async () => {
    const target = await makeRoots();
    const arrivals = createArrivals(servicesFor(target));

    const bundle = await arrivals.plan(await realBundle(), LIMIT);
    const definition = await arrivals.plan(streamOf(DEFINITION), LIMIT);
    expect(definition.token).not.toBe(bundle.token);

    // The bundle's token is dead, and it is dead as STALENESS rather than as a bad file: the card's answer to
    // one is "read it again", to the other "that is not a bundle".
    await expect(arrivals.apply({ token: bundle.token, items: [], includeSecrets: false })).rejects.toThrow(/no held arrival/);

    await cleanup();
});

test("abandoning drops the held artifact and answers whether there was one", async () => {
    const arrivals = createArrivals(servicesFor(await makeRoots()));
    expect(await arrivals.abandon()).toBe(false);
    await arrivals.plan(streamOf(DEFINITION), LIMIT);
    expect(await arrivals.abandon()).toBe(true);
    expect(await arrivals.abandon()).toBe(false);
    await cleanup();
});

test("a document that is TOML but not a definition is refused by what it says, not by its extension", async () => {
    const arrivals = createArrivals(servicesFor(await makeRoots()));
    await expect(arrivals.plan(streamOf('title = "just some toml"\n'), LIMIT)).rejects.toThrow(/not a sandbox definition/);
    await cleanup();
});
