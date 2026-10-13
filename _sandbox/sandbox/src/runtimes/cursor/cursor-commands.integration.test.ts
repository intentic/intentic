import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeWirePrompt } from "../../agent/prompt/turn-preamble.js";
import { cursorCommands, expandCursorCommand } from "./cursor-commands.js";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cursor-commands-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const write = (name: string, text: string): void => {
    mkdirSync(join(root, ".cursor", "commands"), { recursive: true });
    writeFileSync(join(root, ".cursor", "commands", name), text);
};

test("each Markdown file is a command, described by its frontmatter or its first line", async () => {
    write("ship.md", "---\ndescription: Ship the branch\n---\nRun the checks, then push.");
    write("fix.md", "## Fix the failing test\nFind it, fix it.");
    write("notes.txt", "not a command");
    write("empty.md", "   ");
    expect((await cursorCommands(root)).map(({ name, description }) => [name, description])).toEqual([
        ["fix", "Fix the failing test"],
        ["ship", "Ship the branch"],
    ]);
});

test("a project without the folder has no commands", async () => {
    expect(await cursorCommands(root)).toEqual([]);
});

describe("a message that opens with a command", () => {
    const commands = [{ name: "ship", description: "Ship", body: "Run the checks, then push." }];

    test("is sent as the command's text, what follows the name after it", () => {
        expect(expandCursorCommand("/ship to staging", commands)).toBe("Run the checks, then push.\n\nto staging");
        expect(expandCursorCommand("/ship", commands)).toBe("Run the checks, then push.");
    });

    test("keeps the daemon's notes in front of it", () => {
        const prompt = composeWirePrompt([{ title: "Map of this project", text: "## Map of this project\n\nsrc/" }], "/ship now");
        const expanded = expandCursorCommand(prompt, commands);
        expect(expanded.startsWith("## Map of this project")).toBe(true);
        expect(expanded.endsWith("Run the checks, then push.\n\nnow")).toBe(true);
    });

    test("naming no command, or a path, is sent as typed", () => {
        expect(expandCursorCommand("/unknown thing", commands)).toBe("/unknown thing");
        expect(expandCursorCommand("/etc/hosts is broken", commands)).toBe("/etc/hosts is broken");
    });
});
