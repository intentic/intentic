import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, writeSecretFile } from "./home.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "home-"));

describe("writeFileAtomic", () => {
    it("replaces the file whole and leaves no staging file beside it", async () => {
        const at = dir();
        const path = join(at, "device.json");
        writeFileSync(path, `{"links":[1,2,3]}`);

        await writeFileAtomic(path, `{"links":[]}`);

        expect(readFileSync(path, "utf8")).toBe(`{"links":[]}`);
        expect(readdirSync(at)).toEqual(["device.json"]);
    });

    // Every reader of these files acts on what it read, and the one that read a torn device.json wiped every link.
    it("never shows a reader anything but one whole version while writes race", async () => {
        const path = join(dir(), "state.json");
        const versions = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index, pad: "x".repeat(50_000) }));

        const seen: string[] = [];
        await Promise.all([
            ...versions.map(async (body) => await writeFileAtomic(path, body)),
            (async () => {
                for (let read = 0; read < 50; read++) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- reads interleaved with the writes on purpose
                    seen.push(await Bun.file(path).text().catch(() => versions[0] ?? ""));
                }
            })(),
        ]);

        expect(seen.every((body) => versions.includes(body))).toBe(true);
    });
});

describe.skipIf(process.platform === "win32")("writeSecretFile", () => {
    it("leaves the file readable by its owner only, even when it existed with wider permissions", async () => {
        const at = dir();
        const path = join(at, "device.json");
        writeFileSync(path, "{}", { mode: 0o644 });

        await writeSecretFile(path, at, `{"links":[]}`);

        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(at).mode & 0o777).toBe(0o700);
    });
});
