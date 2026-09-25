import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineIdSchema } from "@intentic/sandbox-contract";
import { MACHINE_ID_ENV, machineId } from "./machine-id.js";

// Which computer this is: minted once and kept, and handed down to a distro's agent by its Windows side, so every
// environment of one PC answers with the one id its enrollments and rows are joined on.

const place = (): string => join(mkdtempSync(join(tmpdir(), "machine-id-")), "machine-id");

test("mints an id once and answers the same one every time after", async () => {
    const path = place();
    const first = machineId({}, path);
    expect(MachineIdSchema.safeParse(first).success).toBe(true);
    expect(first).toMatch(/^m-[0-9a-f-]{36}$/);
    expect(machineId({}, path)).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
});

// A distro's agent is started by the Windows side with the PC's id: it is an environment of that computer. One that
// ran on its own before (and minted an id of its own) takes the PC's from then on.
test("takes the id its Windows side hands it, over one it minted before", async () => {
    const path = place();
    machineId({}, path);
    const pc = "m-0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(machineId({ [MACHINE_ID_ENV]: pc }, path)).toBe(pc);
    expect(machineId({}, path)).toBe(pc);
});

// A file somebody edited into nonsense, or an env value that is not an id, is not an identity to keep answering with.
test("replaces a stored value that is not an id, and ignores a handed one that is not either", async () => {
    const path = place();
    await writeFile(path, "not an id\n");
    const minted = machineId({ [MACHINE_ID_ENV]: "no" }, path);
    expect(minted).toMatch(/^m-[0-9a-f-]{36}$/);
    expect(machineId({}, path)).toBe(minted);
});
