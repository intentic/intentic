import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/* THE SUITE DOES NOT GET TO TOUCH THIS MACHINE'S ENGINE STORE. A vitest setup file, not a helper, for the same
 * reason tmux-fence.ts is one: the tests that need it do not know they do.
 *
 * The engine store is where installed agent runtimes live (/history/engines, engines/engine-store.ts), and it
 * is REAL on the machine a suite runs on — in this sandbox it is the store the daemon serving the owner's own
 * turns reads. Two things go wrong without a fence, and both were observed rather than imagined:
 *
 *   READS. Any test that goes anywhere near engine resolution answers from whatever this machine happens to
 *   have installed. The Cursor loader's suite asserts which of three copies wins, and with a real store on the
 *   box it silently asserted against a version some earlier run had downloaded.
 *
 *   WRITES. A test that reaches an install path performs a real `npm install` into the owner's volume. One run
 *   put 55 MB of @cursor/sdk there before anybody noticed, and a suite that can install can also activate: the
 *   pointer it moves is the one the next real turn reads.
 *
 * So every project gets a throwaway store, made once per worker and removed after. Suites that want to test
 * the store itself still set their own INTENTIC_ENGINES_DIR per case; this is the floor, not a ceiling. */

let fence: string | undefined;

beforeAll(() => {
    fence = mkdtempSync(join(tmpdir(), `intentic-engines-`));
    process.env["INTENTIC_ENGINES_DIR"] = fence;
});

afterAll(() => {
    if (fence !== undefined) {
        rmSync(fence, { recursive: true, force: true });
        fence = undefined;
    }
    delete process.env["INTENTIC_ENGINES_DIR"];
});
