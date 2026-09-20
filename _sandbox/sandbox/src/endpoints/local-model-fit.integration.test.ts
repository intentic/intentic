import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { LOCAL_MODEL_INSTANT, LOCAL_MODEL_WINDOW_DEFAULT, LOCAL_MODELS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { estimatedModelMemory, fitsBudget, localModelFit } from "./local-model-fit.js";

// What the connect view sizes its offer against, read off a real workspace tree: which weights are already cached is a
// stat, and the memory and GPU readings are this container's own. The arithmetic alone is the unit half.

const IDLE = { model: LOCAL_MODEL_INSTANT.id, state: "idle" as const, receivedBytes: 0, totalBytes: 0 };

test("every curated model is priced at every window, and held says what is already on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "fit-"));
    const fit = await localModelFit(root, IDLE);
    expect(fit.options.map((option) => option.model)).toEqual(LOCAL_MODELS.map((choice) => choice.id));
    for (const option of fit.options) {
        expect(option.held).toBe(false);
        // Each rung's total is the same number the admission check would compute, so no surface has to redo it.
        for (const window of option.windows) {
            expect(window.totalBytes).toBe(estimatedModelMemory(option.weightsBytes, window.tokens));
            expect(window.fits).toBe(fitsBudget(fit.budgetBytes, option.weightsBytes, window.tokens));
        }
    }

    // A file already in the cache costs no download, whichever card put it there.
    await mkdir(join(root, STATE_DIR, "local/cache/models"), { recursive: true });
    const file = LOCAL_MODEL_INSTANT.id.split("/").at(-1)!;
    await writeFile(join(root, STATE_DIR, "local/cache/models", file), "weights");
    const second = await localModelFit(root, IDLE);
    expect(second.options.find((option) => option.model === LOCAL_MODEL_INSTANT.id)?.held).toBe(true);
});

// The offer is the whole point of the route: a model plus the window it was priced at, addable verbatim.
test("both offers name a window that fits, and never one above the turn-sized default", async () => {
    const root = await mkdtemp(join(tmpdir(), "fit-"));
    const fit = await localModelFit(root, IDLE);
    for (const offered of [fit.instant, fit.best].filter((entry) => entry !== undefined)) {
        const choice = LOCAL_MODELS.find((entry) => entry.id === offered.model)!;
        expect(Number(offered.context)).toBeLessThanOrEqual(Number(LOCAL_MODEL_WINDOW_DEFAULT));
        expect(fitsBudget(fit.budgetBytes, choice.weightsBytes, Number(offered.context))).toBe(true);
    }
    // Whatever this machine is, the instant rung is the one that is instant.
    expect(fit.instant?.model ?? LOCAL_MODEL_INSTANT.id).toBe(LOCAL_MODEL_INSTANT.id);
    // And the best offer is never a rung sold as quick-jobs-only.
    expect(LOCAL_MODELS.find((entry) => entry.id === fit.best?.model)?.tier ?? "work").toBe("work");
});
