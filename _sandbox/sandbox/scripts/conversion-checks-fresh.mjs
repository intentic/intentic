// Exits 0 when src/store/generated/state-shapes.ts is already what `write-state-shapes.ts --checks` would write, judged
// by the digest of its inputs it is stamped with (src/store/shapes/state-modules.ts conversionChecksInputs), and 1 when it
// must be written again: the package's `pretypecheck` runs the generator only then. Plain `node`, with the scan module's
// types stripped by node itself, so a typecheck with nothing to regenerate starts no tsx and loads no document module.
// Every failure here is a 1: the generator then runs and says what is wrong.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONVERSION_CHECKS_STAMP, conversionChecksInputs, stateModules } from "../src/store/shapes/state-modules.ts";

const source = join(dirname(import.meta.dirname), "src");
const generated = join(source, "store", "generated");
try {
    const { documents } = await stateModules(source);
    // No record yet reads as the generator's first-run empty one; any other failed read is doubt, and regenerates below.
    const recordText = await readFile(join(generated, "state-shapes.json"), "utf8").catch((error) => {
        if (error?.code === "ENOENT") {
            return "";
        }
        throw error;
    });
    const want = `${CONVERSION_CHECKS_STAMP}${await conversionChecksInputs(source, documents, recordText)}`;
    const have = (await readFile(join(generated, "state-shapes.ts"), "utf8")).split("\n", 1)[0];
    if (have !== want) {
        process.exit(1);
    }
    process.stdout.write("shape checks: current, not regenerated\n");
} catch {
    // allow(silent-catch): any doubt regenerates, and the generator reports what it finds
    process.exit(1);
}
