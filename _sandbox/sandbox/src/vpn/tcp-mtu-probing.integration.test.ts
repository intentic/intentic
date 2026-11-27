import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableTcpMtuProbing } from "./tcp-mtu-probing.js";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mtu-probing-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("turns black-hole detection on where the kernel default left it off", async () => {
    const path = join(dir, "tcp_mtu_probing");
    await writeFile(path, "0\n");
    expect(await enableTcpMtuProbing(path)).toBeUndefined();
    expect((await readFile(path, "utf8")).trim()).toBe("1");
});

test("leaves a value someone already chose, so always-probe is not downgraded", async () => {
    const path = join(dir, "tcp_mtu_probing");
    await writeFile(path, "2\n");
    expect(await enableTcpMtuProbing(path)).toBeUndefined();
    expect((await readFile(path, "utf8")).trim()).toBe("2");
});

test("says why when the sysctl cannot be reached, rather than failing the dial", async () => {
    expect(await enableTcpMtuProbing(join(dir, "missing", "tcp_mtu_probing"))).toMatch(/ENOENT/);
});
