import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecretFile } from "./home.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "home-"));

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
