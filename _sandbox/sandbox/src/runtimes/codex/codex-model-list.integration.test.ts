import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexModelList } from "./codex-model-list.js";

/* The Codex CLI's own `model/list`, over a real spawned process: what the runtime says about its models is what the picker offers. */

// One row of app-server's answer, shaped as the CLI really publishes it (codex-cli 0.155.1).
const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    model: id,
    displayName: id.toUpperCase(),
    description: `${id} is here`,
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    ...extra,
});

// An app-server that answers model/list once and then waits: the same handshake the real one takes, so the reader is
// exercised over a pipe rather than a stub.
const fakeCodex = async (answer: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "codex-model-list-"));
    const binary = join(dir, "codex");
    await writeFile(
        binary,
        `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { codexHome: process.env.CODEX_HOME } }) + "\\n");
    }
    if (message.method === "model/list") {
        process.stdout.write(${JSON.stringify(answer)}.replace("<id>", String(message.id)) + "\\n");
    }
});
`,
        { mode: 0o755 },
    );
    return binary;
};

const answering = (result: unknown): string => JSON.stringify({ id: "<id>", result }).replace(`"<id>"`, "<id>");

test("publishes every rung the runtime names, in its order, with Codex's own default leading the catalog", async () => {
    const binary = await fakeCodex(
        answering({
            data: [
                row("gpt-5.6-luna"),
                row("gpt-6-astra", {
                    isDefault: true,
                    supportedReasoningEfforts: [
                        { reasoningEffort: "low" },
                        { reasoningEffort: "max" },
                        // A rung no build of Intentic has seen yet still reaches the picker: the runtime's scale is
                        // the runtime's to name.
                        { reasoningEffort: "hyper" },
                        { description: "a rung with no name at all" },
                    ],
                }),
            ],
            nextCursor: null,
        }),
    );

    expect(await codexModelList("/work/.intentic/secrets/auth/codex", async () => binary)()).toEqual([
        { id: "gpt-6-astra", label: "GPT-6-ASTRA", efforts: ["low", "max", "hyper"], description: "gpt-6-astra is here" },
        { id: "gpt-5.6-luna", label: "GPT-5.6-LUNA", efforts: ["low", "xhigh"], description: "gpt-5.6-luna is here" },
    ]);
});

test("leaves out the rows the runtime hides, and the fields it doesn't publish", async () => {
    const binary = await fakeCodex(
        answering({
            data: [row("codex-auto-review", { hidden: true }), { id: "gpt-5.4-mini", supportedReasoningEfforts: [] }],
        }),
    );

    // No display name, no description, no scale: an id alone is still a model, and an empty scale leaves the picker's
    // own floor to answer rather than drawing a ladder with no rungs.
    expect(await codexModelList("/codex-home", async () => binary)()).toEqual([{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }]);
});

test("stays empty when the runtime cannot answer, so a catalog never fails over metadata", async () => {
    const absent = await codexModelList("/codex-home", async () => undefined)();
    const garbled = await codexModelList("/codex-home", async () => await fakeCodex(`{"id": <id>, "error": {"message": "nope"}}`))();

    expect([absent, garbled]).toEqual([[], []]);
});
