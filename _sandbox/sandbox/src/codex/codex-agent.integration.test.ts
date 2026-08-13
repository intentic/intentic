import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fakeCodexRunner } from "../testing.js";
import { createCodexAgent } from "./codex-agent.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an image-generation item becomes a completed tool card with a file-backed image", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-codex-agent-image-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const codexHome = join(root, "codex");
    await Promise.all([mkdir(workspaceRoot), mkdir(join(codexHome, "generated_images"), { recursive: true })]);
    const { runner } = fakeCodexRunner([
        { type: "item.started", item: { id: "ig-1", type: "image_generation", status: "in_progress", result: "" } },
        {
            type: "item.completed",
            item: {
                id: "ig-1",
                type: "image_generation",
                status: "completed",
                revised_prompt: "a friendly green crocodile",
                result: PNG.toString("base64"),
            },
        },
    ]);

    const events = [];
    for await (const event of createCodexAgent({ codexHome, runner })({
        prompt: "draw a crocodile",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
    })) {
        events.push(event);
    }

    expect(events).toEqual([
        { kind: "tool_call", id: "ig-1", name: "Image generation", category: "other", status: "in_progress" },
        {
            kind: "tool_call_update",
            id: "ig-1",
            status: "completed",
            content: [{ type: "image", path: ".intentic/artifacts/imagegen/ig-1.png" }],
        },
        { kind: "done" },
    ]);
    expect(await readFile(join(workspaceRoot, ".intentic/artifacts/imagegen/ig-1.png"))).toEqual(PNG);
});
