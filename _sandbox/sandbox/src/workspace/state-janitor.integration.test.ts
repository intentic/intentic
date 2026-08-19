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
    // The LIVE profile dir, which since the state dir was grouped is a different place entirely from the
    // retired flat one above — and is the thing that must survive the sweep.
    await mkdir(join(root, ".intentic/local/browser/reddit"), { recursive: true });

    await sweepStateAtBoot(root, log);

    expect(await exists(join(root, ".intentic/whisper"))).toBe(false);
    // The whole flat profile root goes now, not just its capture subdir: the live profiles moved under `local`,
    // so everything left at the old spelling is abandoned by definition.
    expect(await exists(join(root, ".intentic/browser"))).toBe(false);
    expect(await exists(join(root, ".intentic/claude"))).toBe(true);
    expect(await exists(join(root, ".intentic/attachments"))).toBe(true);
    // …and the live profiles, one folder over, are untouched by any of it.
    expect(await exists(join(root, ".intentic/local/browser/reddit"))).toBe(true);
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
