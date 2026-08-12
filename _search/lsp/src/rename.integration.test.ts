import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { rename } from "./rename.js";

// Real conversations with the native compiler's language server, against throwaway projects — rename's value
// is that every usage moves, and only the real server can vouch for that.

const made: string[] = [];
const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-rename-"));
    made.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const project = (dir: string): void => {
    writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true,"module":"nodenext"},"include":["src"]}');
    mkdirSync(join(dir, "src"));
};

test("a rename moves the declaration and every cross-file usage, preserving shorthand properties", async () => {
    const dir = fixture();
    project(dir);
    writeFileSync(join(dir, "src", "util.ts"), "export const getUser = (id: number): string => `user-${id}`;\n");
    writeFileSync(
        join(dir, "src", "app.ts"),
        'import { getUser } from "./util.js";\nconst box = { getUser };\nexport const s = getUser(1) + box.getUser(2);\n',
    );
    const result = await rename(join(dir, "src", "util.ts"), "getUser", "fetchUser");
    expect(result.changedFiles).toHaveLength(2);
    expect(readFileSync(join(dir, "src", "util.ts"), "utf8")).toContain("export const fetchUser");
    const app = readFileSync(join(dir, "src", "app.ts"), "utf8");
    expect(app).toContain('import { fetchUser } from "./util.js"');
    // The shorthand keeps its property name — `{ getUser }` becomes `{ getUser: fetchUser }`, not a new key.
    expect(app).toContain("{ getUser: fetchUser }");
    expect(app).toContain("box.getUser(2)");
});

// A parameter never appears in the document outline; the lexical fallback offers positions until the server
// agrees to rename from one.
test("a symbol the outline does not carry is still renamed via the lexical fallback", async () => {
    const dir = fixture();
    project(dir);
    const file = join(dir, "src", "geo.ts");
    writeFileSync(file, "export const area = (width: number, height: number): number => width * height;\n");
    const result = await rename(file, "width", "w");
    expect(result.edits).toBe(2);
    expect(readFileSync(file, "utf8")).toBe("export const area = (w: number, height: number): number => w * height;\n");
});

test("nothing by the requested name is an error, not a guess", async () => {
    const dir = fixture();
    project(dir);
    const file = join(dir, "src", "a.ts");
    writeFileSync(file, "export const x = 1;\n");
    await expect(rename(file, "nosuchthing", "y")).rejects.toThrow('nothing named "nosuchthing"');
});
