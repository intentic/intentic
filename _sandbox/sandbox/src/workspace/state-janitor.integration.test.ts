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
    await mkdir(join(root, ".intentic/tmp/demo"), { recursive: true });
    await writeFile(join(root, ".intentic/tmp/build.log"), "…");

    await sweepStateAtBoot(root, log);

    expect(await exists(join(root, ".intentic/tmp"))).toBe(true);
    expect(await readdir(join(root, ".intentic/tmp"))).toEqual([]);
});

test("boot sweep deletes retired DERIVED roots and leaves secret and artifact quarantine alone", async () => {
    const root = await workspace();
    // A retired derived root (the abandoned whisper home) and a nested one (the pre-artifacts capture dir).
    await mkdir(join(root, ".intentic/whisper"), { recursive: true });
    await writeFile(join(root, ".intentic/whisper/ggml-small.bin"), "model bytes");
    await mkdir(join(root, ".intentic/browser/output"), { recursive: true });
    await writeFile(join(root, ".intentic/browser/output/page.png"), "png");
    // Quarantined but NOT the janitor's to delete: a retired secret root and a retired artifacts root.
    await mkdir(join(root, ".intentic/claude"), { recursive: true });
    await mkdir(join(root, ".intentic/attachments"), { recursive: true });

    await sweepStateAtBoot(root, log);

    expect(await exists(join(root, ".intentic/whisper"))).toBe(false);
    expect(await exists(join(root, ".intentic/browser/output"))).toBe(false);
    expect(await exists(join(root, ".intentic/claude"))).toBe(true);
    expect(await exists(join(root, ".intentic/attachments"))).toBe(true);
    // The live profile dir beside the retired output subdir survives its sibling's deletion.
    expect(await exists(join(root, ".intentic/browser"))).toBe(true);
});

test("aged sweep deletes month-old captures and keeps fresh ones and everything else in artifacts/", async () => {
    const root = await workspace();
    const captures = join(root, ".intentic/artifacts/browser");
    await mkdir(captures, { recursive: true });
    await writeFile(join(captures, "old.png"), "png");
    const monthsAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(join(captures, "old.png"), monthsAgo, monthsAgo);
    await writeFile(join(captures, "fresh.png"), "png");
    // An attachment older than the window: not a capture, not this sweep's to age out.
    await mkdir(join(root, ".intentic/artifacts/attachments"), { recursive: true });
    await writeFile(join(root, ".intentic/artifacts/attachments/report.pdf"), "pdf");
    await utimes(join(root, ".intentic/artifacts/attachments/report.pdf"), monthsAgo, monthsAgo);

    await sweepAgedState(root, Date.now(), log);

    expect(await exists(join(captures, "old.png"))).toBe(false);
    expect(await exists(join(captures, "fresh.png"))).toBe(true);
    expect(await exists(join(root, ".intentic/artifacts/attachments/report.pdf"))).toBe(true);
});
