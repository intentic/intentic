import { expect, test } from "vitest";
import { diagnoseArchive } from "./diagnose.js";

const files = (...paths: string[]): Map<string, Buffer> => new Map(paths.map((path) => [path, Buffer.from("x")]));

/* Each of these is a real mistake with a different next move. The rule they all serve: never answer a failed
 * upload by repeating the instruction the user just followed. */

test("an empty archive points at the error the pack command already printed", () => {
    expect(diagnoseArchive(new Map())).toContain("empty");
    expect(diagnoseArchive(new Map())).toContain("run it again");
});

test("workspace files without a settings file name the marker that gave it away", () => {
    const marker = "SOUL.md";
    const message = diagnoseArchive(files(marker, "memory/2026-01-01.md", "skills/x/SKILL.md"));
    expect(message).toContain(marker);
    expect(message).not.toContain("whole home directory");
});

test("a whole home directory is recognized as one rather than listed file by file", () => {
    const message = diagnoseArchive(
        files(
            ...["Documents", "Downloads", "Pictures", "Music", "Videos", "Desktop", "code", "tmp", ".ssh", ".cache", ".config", "notes", "x"].map(
                (dir) => `${dir}/file.txt`,
            ),
        ),
    );
    expect(message).toContain("whole home directory");
    expect(message).not.toContain("SOUL.md");
});

test("anything else names what the archive actually held, so the mismatch is visible", () => {
    const message = diagnoseArchive(files("myproject/readme.md", "myproject/src/index.ts"));
    expect(message).toContain("myproject");
    expect(message).toContain("2 files");
});

test("a nested setup is NOT diagnosed: it is recognized, so this never runs for one", () => {
    // Guard on the guard: the anchor at any depth means the reader rebased and never reached diagnose.
    const message = diagnoseArchive(files("backup/2026/config.yaml", "backup/2026/SOUL.md"));
    expect(message).not.toContain("workspace folder");
});
