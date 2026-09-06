import { mkdtemp, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test } from "vitest";
import { sweepAgedState, sweepStateAtBoot } from "./state-janitor.js";

const log = pino({ enabled: false });

const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "janitor-"));
    await mkdir(join(root, ".intentic"), { recursive: true });
    return root;
};

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

test("boot sweep empties tmp/ but keeps the directory for the next writer", async () => {
    const root = await workspace();
    await mkdir(join(root, ".intentic/local/tmp/demo"), { recursive: true });
    await writeFile(join(root, ".intentic/local/tmp/build.log"), "…");

    await sweepStateAtBoot(root, log);

    expect(await exists(join(root, ".intentic/local/tmp"))).toBe(true);
    expect(await readdir(join(root, ".intentic/local/tmp"))).toEqual([]);
});

/* THE SWEEP DELETES WHAT THE TABLE CLASSES AS DISPOSABLE, AND NOTHING ELSE. Every rule it has is derived from
 * a class, so a tree the table has no name for is not the janitor's to touch: "I don't recognise this" is the
 * one input that must never resolve to `rm -rf`, because it is exactly what a store added tomorrow, and a
 * directory an owner put there by hand, both look like. */
test("boot sweep leaves declared state and undeclared trees alike alone", async () => {
    const root = await workspace();
    await mkdir(join(root, ".intentic/local/tmp"), { recursive: true });
    // Declared, and not disposable: credentials, config and the live browser profiles.
    await mkdir(join(root, ".intentic/secrets/auth/claude"), { recursive: true });
    await mkdir(join(root, ".intentic/records/artifacts/attachments"), { recursive: true });
    await mkdir(join(root, ".intentic/local/browser/reddit"), { recursive: true });
    // Undeclared: a tree at the state root that no entry in the table claims.
    await mkdir(join(root, ".intentic/some-future-store"), { recursive: true });
    await writeFile(join(root, ".intentic/some-future-store/state.bin"), "bytes");

    await sweepStateAtBoot(root, log);

    expect(await exists(join(root, ".intentic/secrets/auth/claude"))).toBe(true);
    expect(await exists(join(root, ".intentic/records/artifacts/attachments"))).toBe(true);
    expect(await exists(join(root, ".intentic/local/browser/reddit"))).toBe(true);
    expect(await exists(join(root, ".intentic/some-future-store/state.bin"))).toBe(true);
});

test("aged sweep deletes month-old captures and keeps fresh ones and everything else in artifacts/", async () => {
    const root = await workspace();
    const captures = join(root, ".intentic/records/artifacts/browser");
    await mkdir(captures, { recursive: true });
    await writeFile(join(captures, "old.png"), "png");
    const monthsAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(join(captures, "old.png"), monthsAgo, monthsAgo);
    await writeFile(join(captures, "fresh.png"), "png");
    // An attachment older than the window: not a capture, not this sweep's to age out.
    await mkdir(join(root, ".intentic/records/artifacts/attachments"), { recursive: true });
    await writeFile(join(root, ".intentic/records/artifacts/attachments/report.pdf"), "pdf");
    await utimes(join(root, ".intentic/records/artifacts/attachments/report.pdf"), monthsAgo, monthsAgo);

    await sweepAgedState(root, Date.now(), log);

    expect(await exists(join(captures, "old.png"))).toBe(false);
    expect(await exists(join(captures, "fresh.png"))).toBe(true);
    expect(await exists(join(root, ".intentic/records/artifacts/attachments/report.pdf"))).toBe(true);
});
