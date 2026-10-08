import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKCustomTool } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { pesel } from "../../privacy/detect/tests/ids.testing.js";
import { privacySliceFake } from "../../privacy/privacy-slice.testing.js";
import type { TurnShield } from "../../privacy/privacy-shield.js";
import { tokenOf } from "../../privacy/tokens.js";
import { createEventRestorer, cursorHookShield, instructionRefusal, restoreEdits, shieldedCustomTools } from "./cursor-shield.js";

// The privacy shield on Cursor's runtime, over the real shield (detectors, vault, masker): what each of Cursor's
// channels is answered. The reported case (2026-10-08): the composer warned that Cursor would be turned away before a
// word was written, when what the shield should stop is personal data reaching the model, channel by channel.

const NUMBER = pesel(1985, 3, 14, 4562);
const TOKEN = tokenOf("NATIONAL_ID", 1);

const shieldFor = async (mode: "on" | "watch" = "on"): Promise<TurnShield> => {
    const shield = await privacySliceFake({ policy: { mode } }).privacyShield.forTurn("cursor", "native", "c-1");
    if (shield === undefined) {
        throw new Error("no shield");
    }
    return shield;
};

describe("a file Cursor's read tool opens", () => {
    test("is refused when it holds personal data, with the shell named as the way to read it masked", async () => {
        const refusal = await cursorHookShield(await shieldFor()).read({ path: "clients.csv", content: `name: Client\npesel: ${NUMBER}\n`, image: undefined });
        expect(refusal).toContain("clients.csv holds personal data (national identity numbers)");
        expect(refusal).toContain("Read it with the shell instead");
    });

    test("goes when it holds none, and while the shield only watches", async () => {
        expect(await cursorHookShield(await shieldFor()).read({ path: "a.ts", content: "export const a = 1;", image: undefined })).toBeUndefined();
        expect(await cursorHookShield(await shieldFor("watch")).read({ path: "c.csv", content: NUMBER, image: undefined })).toBeUndefined();
    });

    // Read raw, a token-shaped literal would come back unmarked and be read back by number when the model writes it.
    test("is refused when it holds token-shaped text, which only the shell marks as a literal", async () => {
        const refusal = await cursorHookShield(await shieldFor()).read({ path: "fixture.ts", content: `expect(x).toBe("${TOKEN}")`, image: undefined });
        expect(refusal).toContain("shaped like the privacy shield's tokens");
    });

    test("is refused as a picture the shield can't read, or one too large to have been read", async () => {
        const shield = cursorHookShield(await shieldFor());
        expect(await shield.read({ path: "scan.png", content: undefined, image: Buffer.from("png") })).toContain("could not read on this machine");
        expect(await shield.read({ path: "huge.png", content: undefined, image: Buffer.alloc(0) })).toContain("could not read on this machine");
    });
});

describe("a tool call on its way", () => {
    test("is refused for the tools that read past the shield, while it masks", async () => {
        const shield = cursorHookShield(await shieldFor());
        for (const tool of ["Grep", "List", "Fetch", "ReadLints", "ComputerUse"]) {
            const verdict = await shield.tool({ tool, input: {}, existing: undefined });
            expect("refuse" in verdict && verdict.refuse).toContain(`The ${tool} tool reads past the privacy shield`);
        }
        expect(await cursorHookShield(await shieldFor("watch")).tool({ tool: "Grep", input: {}, existing: undefined })).toEqual({ input: undefined });
    });

    test("has its tokens read back, and goes untouched when it holds none", async () => {
        const turn = await shieldFor();
        await turn.mask(`PESEL ${NUMBER}`, "shell");
        const shield = cursorHookShield(turn);
        expect(await shield.tool({ tool: "Shell", input: { command: `grep ${TOKEN} clients.csv`, cwd: "/work" }, existing: undefined })).toEqual({
            input: { command: `grep ${NUMBER} clients.csv`, cwd: "/work" },
        });
        expect(await shield.tool({ tool: "Shell", input: { command: "ls" }, existing: undefined })).toEqual({ input: undefined });
    });

    // Its result would echo the lines it replaced, values and all.
    test("is refused as a whole-file write over a file holding personal data, and goes over one holding none", async () => {
        const shield = cursorHookShield(await shieldFor());
        const refused = await shield.tool({ tool: "Write", input: { file_path: "clients.csv", content: "x" }, existing: `pesel: ${NUMBER}` });
        expect("refuse" in refused && refused.refuse).toContain("clients.csv holds personal data");
        expect(await shield.tool({ tool: "Write", input: { file_path: "a.ts", content: "x" }, existing: "export {};" })).toEqual({ input: undefined });
    });
});

test("an edit's new lines are read back where they landed, and nothing else in the file is touched", () => {
    const restore = (text: string): string => text.replaceAll(TOKEN, NUMBER);
    const file = `# Clients\nPESEL: ${TOKEN}\nunrelated\n`;
    expect(restoreEdits(file, [{ new_string: `PESEL: ${TOKEN}` }], restore)).toBe(`# Clients\nPESEL: ${NUMBER}\nunrelated\n`);
    expect(restoreEdits("plain\n", [{ new_string: "plain" }], restore)).toBeUndefined();
});

describe("the rules Cursor loads itself", () => {
    const project = (files: Record<string, string>): string => {
        const root = mkdtempSync(join(tmpdir(), "cursor-rules-"));
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(join(root, path, ".."), { recursive: true });
            writeFileSync(join(root, path), text);
        }
        return root;
    };

    test("refuse the turn when they hold personal data, naming the files and the way through", async () => {
        const root = project({
            "AGENTS.md": "Build with pnpm.",
            "app/AGENTS.md": `Escalate to PESEL ${NUMBER}.`,
            ".cursor/rules/style.mdc": "Use tabs.",
            "node_modules/pkg/AGENTS.md": `PESEL ${NUMBER}`,
        });
        const refusal = await instructionRefusal(await shieldFor(), root, "Cursor");
        expect(refusal).toContain("app/AGENTS.md holds personal data (national identity numbers)");
        expect(refusal).not.toContain("node_modules");
        expect(refusal).toContain("Let Cursor read this conversation as it is");
    });

    test("say nothing when they hold none, or the shield only watches", async () => {
        expect(await instructionRefusal(await shieldFor(), project({ "AGENTS.md": "Build with pnpm." }), "Cursor")).toBeUndefined();
        expect(await instructionRefusal(await shieldFor("watch"), project({ "AGENTS.md": `PESEL ${NUMBER}` }), "Cursor")).toBeUndefined();
    });
});

describe("what the transcript shows", () => {
    const restore = (text: string): string => text.replaceAll(TOKEN, NUMBER);

    test("a token split across two deltas is read back whole, and nothing is lost at the end", () => {
        const restorer = createEventRestorer(restore);
        const frames = [
            ...restorer.map({ kind: "delta", text: `PESEL ${TOKEN.slice(0, 6)}` }),
            ...restorer.map({ kind: "delta", text: `${TOKEN.slice(6)} found, and ⟦` }),
            ...restorer.flush(),
        ];
        expect(frames.map((frame) => (frame.kind === "delta" ? frame.text : "")).join("")).toBe(`PESEL ${NUMBER} found, and ⟦`);
    });

    test("a tool card is read back whole, after the prose before it has let go", () => {
        const restorer = createEventRestorer(restore);
        expect(restorer.map({ kind: "delta", text: "Running ⟦" })).toEqual([{ kind: "delta", text: "Running " }]);
        const card: AgentEvent = { kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: `PESEL ${TOKEN}` }] };
        expect(restorer.map(card)).toEqual([
            { kind: "delta", text: "⟦" },
            { kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: `PESEL ${NUMBER}` }] },
        ]);
    });
});

test("the daemon's own tools get the model's tokens as values, and hand back what they answer masked", async () => {
    const turn = await shieldFor();
    await turn.mask(`PESEL ${NUMBER}`, "shell");
    const seen: unknown[] = [];
    const tools: Record<string, SDKCustomTool> = {
        code: {
            execute: async (args) => {
                seen.push(args);
                return { content: [{ type: "text", text: `ran: PESEL ${NUMBER}` }] };
            },
        },
    };
    const result = await shieldedCustomTools(tools, turn)["code"]?.execute({ code: `console.log("${TOKEN}")` }, {});
    expect(seen).toEqual([{ code: `console.log("${NUMBER}")` }]);
    expect(result).toEqual({ content: [{ type: "text", text: `ran: PESEL ${TOKEN}` }] });
});
