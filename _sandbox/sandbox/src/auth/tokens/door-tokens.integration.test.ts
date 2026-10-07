import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestUnreadableError } from "../../store/json-file.js";
import { fileDoorTokens, presentedDoorToken } from "./door-tokens.js";

// Set aside and rewritten, an unreadable door file would re-mint every door on the next look and break every URL
// already taught to a sender. Refused instead, and the file stays as it was for a person to fix.
test("a door file this build cannot read refuses a mint and a rotation, and stays as it was", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "doors-")), "doors.json");
    const doors = fileDoorTokens(path);
    const taught = await doors.ensure("automation", "nightly");
    await writeFile(path, "{ this is not json", "utf8");

    await expect(doors.ensure("automation", "nightly")).rejects.toBeInstanceOf(ManifestUnreadableError);
    await expect(doors.rotate("gate", "deploy")).rejects.toBeInstanceOf(ManifestUnreadableError);
    expect(await readFile(path, "utf8")).toBe("{ this is not json");
    expect(existsSync(`${path}.corrupt`)).toBe(false);
    expect(await doors.verify("automation", "nightly", taught)).toBe(false);
});

// A webhook sender can only carry a URL, so `?token=` stays accepted; a bearer wins when both are there.
test("the presented door credential is the bearer when there is one, else the query's", () => {
    const headers = (authorization?: string) => new Headers(authorization === undefined ? {} : { authorization });
    expect(presentedDoorToken(headers("Bearer from-header"), "from-query")).toBe("from-header");
    expect(presentedDoorToken(headers(), "from-query")).toBe("from-query");
    expect(presentedDoorToken(headers("Basic abc"), "from-query")).toBe("from-query");
    expect(presentedDoorToken(headers(), undefined)).toBe("");
});
