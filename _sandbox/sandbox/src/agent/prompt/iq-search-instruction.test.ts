import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { SEARCH_GUIDANCE } from "./guidance.js";
import { iqSearchInstruction } from "./iq-search-instruction.js";

// The cohort names the treatment the iq arm received, which is the teaching's note AND the system prompt's search line:
// a cohort hashed over the note alone would blend conversations told two different things into one experiment.

const PLUGIN_DIR = join(repoRoot(import.meta.url), "_search/iq/plugin");
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

test("the cohort moves with the system prompt's iq search line, not only with the teaching note", async () => {
    const body = (await readFile(join(PLUGIN_DIR, "hooks/nudge.txt"), "utf8")).trim();
    const { cohort } = await iqSearchInstruction(PLUGIN_DIR);

    expect(cohort).not.toBe(short(body));
    expect(cohort).toBe(short(`${body}\0${SEARCH_GUIDANCE.iq}`));
});
