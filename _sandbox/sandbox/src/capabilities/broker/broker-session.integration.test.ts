import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerSessions } from "./broker-session.js";

// The broker's address key on the disk: minted once, kept root-only, and the same key for every signer of the file.

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-key-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const session = { capability: "github", route: 0, upstream: "https://api.github.com/", conversationId: "c1" };

// Spelled two ways, so neither signer shares the other's in-process load: whichever loses the publish reads the
// winner's key back.
test("two concurrent first loads of the key agree, and the key is kept root-only", async () => {
    const key = join(dir, "broker.key");
    const [a, b] = [brokerSessions(key), brokerSessions(`${dir}/./broker.key`)];
    const [fromA, fromB, tagA, tagB] = await Promise.all([a.sign(session), b.sign(session), a.tag("socket"), b.tag("socket")]);
    expect(fromA).toBe(fromB);
    expect(tagA).toBe(tagB);
    expect(await brokerSessions(key).verify(fromA)).toEqual(session);
    expect((await readFile(key)).length).toBe(32);
    expect(((await stat(key)).mode & 0o777).toString(8)).toBe("600");
});
