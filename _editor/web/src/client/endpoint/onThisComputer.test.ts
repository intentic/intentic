import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// The browser's memory of which sandboxes answered over loopback, against the page's own localStorage: a fresh module
// per test, since it reads storage once on load.
const load = (): Promise<typeof import("./onThisComputer")> => freshImport("./onThisComputer", import.meta.url);

const TUNNEL = `https://sandbox-82789f4106b4.sbx.intentic.dev`;

beforeEach(() => {
    localStorage.clear();
});

test(`a loopback answer is remembered past a reload`, async () => {
    (await load()).rememberRoute(`s1`, { kind: `local`, base: `https://local.example:41234` });
    const reloaded = await load();
    expect(reloaded.seenOnThisComputer(`s1`)).toBe(true);
    expect(reloaded.seenOnThisComputer(`s2`)).toBe(false);
});

test(`the tunnel answering in its place forgets it, and answering nowhere leaves it as it was`, async () => {
    const memory = await load();
    memory.rememberRoute(`s1`, { kind: `local-insecure`, base: `http://127.0.0.1:41234` });
    memory.rememberRoute(`s1`, { kind: `public`, base: TUNNEL, unanswered: true });
    expect(memory.seenOnThisComputer(`s1`)).toBe(true);
    memory.rememberRoute(`s1`, { kind: `public`, base: TUNNEL });
    expect(memory.seenOnThisComputer(`s1`)).toBe(false);
    expect((await load()).seenOnThisComputer(`s1`)).toBe(false);
});
