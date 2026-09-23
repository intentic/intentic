import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editBytesReviewer } from "./edit-bytes.js";

// A real file and a real repository: the scan reads bytes off disk and asks git whether the file is ignored.

const root = mkdtempSync(join(tmpdir(), "edit-bytes-"));
execFileSync("git", ["init", "-q"], { cwd: root });
writeFileSync(join(root, ".gitignore"), "*.log\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const reviewer = editBytesReviewer({
    onDisk: (file) => file,
    relative: (file) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined),
});

const written = (name: string, bytes: readonly number[]): string => {
    const path = join(root, name);
    writeFileSync(path, Buffer.from(bytes));
    return path;
};

// "ab\ncNd" with N a NUL: the byte sits on line 2, column 2.
const WITH_NUL = [0x61, 0x62, 0x0a, 0x63, 0x00, 0x64];

describe(`the byte scan on an edit`, () => {
    test(`a literal NUL is named by line, column and the escape to write instead`, async () => {
        const message = await reviewer(written("recommend.ts", WITH_NUL), "this edit");
        expect(message).toContain("1 literal control byte in recommend.ts after this edit");
        expect(message).toContain("recommend.ts:2:2  literal NUL, write it as \\u0000");
    });

    test(`a clean file says nothing`, async () => {
        expect(await reviewer(written("clean.ts", [0x61, 0x09, 0x62, 0x0a]), "this edit")).toBeUndefined();
    });

    test(`a binary extension, an ignored file and a file outside the tree are nobody's source`, async () => {
        expect(await reviewer(written("icon.png", WITH_NUL), "this edit")).toBeUndefined();
        expect(await reviewer(written("run.log", WITH_NUL), "this command")).toBeUndefined();
        const outside = join(mkdtempSync(join(tmpdir(), "edit-bytes-outside-")), "scratch.ts");
        writeFileSync(outside, Buffer.from(WITH_NUL));
        expect(await reviewer(outside, "this command")).toBeUndefined();
    });

    test(`a file that cannot be read says nothing rather than failing the edit`, async () => {
        expect(await reviewer(join(root, "missing.ts"), "this edit")).toBeUndefined();
    });
});
