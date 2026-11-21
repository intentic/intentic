import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exe } from "../../release.js";
import { AGENT_BUNDLE } from "../mutagen.js";
import { AgentBundleRemovedError, BUNDLE_REFETCH_MS, bundleFetchDue, installPinnedMutagen, type MutagenInstallIo, mutagenNeed } from "./mutagen-binary.js";

// (2026-11-20, intentic#49) A Windows PC ran a pinned mutagen.exe with no agent bundle beside it, from its first connect
// on, and nothing ever fetched the bundle again: the only test of an install was the executable's version.
describe("mutagenNeed", () => {
    it("is whole only with the pinned executable and its bundle", () => {
        expect(mutagenNeed("0.18.1", true)).toBe("nothing");
    });

    it("fetches the bundle alone when the executable is right and the bundle is gone", () => {
        expect(mutagenNeed("0.18.1", false)).toBe("bundle");
    });

    it("fetches everything when the executable is absent or another version, bundle or not", () => {
        expect(mutagenNeed(undefined, true)).toBe("all");
        expect(mutagenNeed("0.17.2", true)).toBe("all");
        expect(mutagenNeed(undefined, false)).toBe("all");
    });
});

describe("bundleFetchDue", () => {
    it("fetches a missing bundle at once the first time, then not again until the wait is over", () => {
        expect(bundleFetchDue(undefined, 1_000)).toBe(true);
        expect(bundleFetchDue(1_000, 1_000 + BUNDLE_REFETCH_MS - 1)).toBe(false);
        expect(bundleFetchDue(1_000, 1_000 + BUNDLE_REFETCH_MS)).toBe(true);
    });
});

describe("installPinnedMutagen", () => {
    let dir: string;
    const dest = (): string => join(dir, `mutagen${exe}`);
    const bundle = (): string => join(dir, AGENT_BUNDLE);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "mutagen-install-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // A release as the tarball unpacks it: both halves, or (`withBundle: false`) one whose bundle security software took.
    const io = ({ withBundle = true } = {}): MutagenInstallIo & { readonly stopped: string[]; readonly extractedInto: string[] } => {
        const stopped: string[] = [];
        const extractedInto: string[] = [];
        return {
            stopped,
            extractedInto,
            fetch: async (tarball) => await writeFile(tarball, "tarball"),
            extract: async (_tarball, into) => {
                extractedInto.push(into);
                await writeFile(join(into, `mutagen${exe}`), "new mutagen");
                if (withBundle) {
                    await writeFile(join(into, AGENT_BUNDLE), "new bundle");
                }
            },
            stopDaemon: async (mutagen) => void stopped.push(mutagen),
        };
    };

    it("unpacks into a staging folder inside bin, never into bin itself, and leaves neither it nor the tarball", async () => {
        const fake = io();
        await installPinnedMutagen(dir, "all", fake, 5_000);
        expect(fake.extractedInto).toHaveLength(1);
        expect(fake.extractedInto[0]).not.toBe(dir);
        expect(fake.extractedInto[0]!.startsWith(join(dir, ".mutagen-staging-"))).toBe(true);
        expect((await readdir(dir)).toSorted()).toEqual([AGENT_BUNDLE, `mutagen${exe}`].toSorted());
    });

    it("replaces the executable and the bundle, setting the running copy aside and dropping it", async () => {
        await writeFile(dest(), "old mutagen");
        const fake = io();
        await installPinnedMutagen(dir, "all", fake, 5_000);
        expect(await readFile(dest(), "utf8")).toBe("new mutagen");
        expect(await readFile(bundle(), "utf8")).toBe("new bundle");
        expect(fake.stopped).toEqual([dest()]);
        expect(existsSync(`${dest()}.old`)).toBe(false);
    });

    it("fetches only the bundle beside a right executable, leaving the executable and its daemon alone", async () => {
        await writeFile(dest(), "pinned mutagen");
        const fake = io();
        await installPinnedMutagen(dir, "bundle", fake, 5_000);
        expect(await readFile(dest(), "utf8")).toBe("pinned mutagen");
        expect(await readFile(bundle(), "utf8")).toBe("new bundle");
        expect(fake.stopped).toEqual([]);
    });

    it("says security software took a bundle that is gone right after unpacking, and changes nothing in bin", async () => {
        await writeFile(dest(), "old mutagen");
        const failed = installPinnedMutagen(dir, "all", io({ withBundle: false }), 5_000);
        await expect(failed).rejects.toBeInstanceOf(AgentBundleRemovedError);
        await expect(installPinnedMutagen(dir, "all", io({ withBundle: false }), 6_000)).rejects.toThrow(/was gone right after it was unpacked/);
        expect(await readFile(dest(), "utf8")).toBe("old mutagen");
        expect(await readdir(dir)).toEqual([`mutagen${exe}`]);
    });

    it("sweeps a crashed install's staging folder and tarball once they are an hour old, and keeps a running one's", async () => {
        const now = Date.now();
        const stale = join(dir, ".mutagen-staging-1-1");
        const staleTarball = join(dir, "mutagen-1-1.tar.gz");
        const fresh = join(dir, ".mutagen-staging-2-2");
        await mkdir(stale);
        await writeFile(staleTarball, "x");
        await mkdir(fresh);
        const hourAgo = new Date(now - 61 * 60_000);
        await utimes(stale, hourAgo, hourAgo);
        await utimes(staleTarball, hourAgo, hourAgo);
        await installPinnedMutagen(dir, "bundle", io(), now);
        const left = await readdir(dir);
        expect(left).not.toContain(".mutagen-staging-1-1");
        expect(left).not.toContain("mutagen-1-1.tar.gz");
        expect(left).toContain(".mutagen-staging-2-2");
    });
});
