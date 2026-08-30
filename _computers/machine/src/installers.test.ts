import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_SCRIPTS, INSTALL_SCRIPTS_DIR } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";

/* THE FOUR INSTALLERS THAT PUT THIS AGENT ON A MACHINE, HELD TO EACH OTHER.
 *
 * `computer.sh`, `sync.sh`, `computer.ps1` and `sync.ps1` are each handed to `curl | sh` or `irm | iex` as one
 * standalone string: there is no import, no dot-sourcing, no shared file, so the block that decides whether to
 * download this agent — and how — genuinely has to exist twice per dialect.
 *
 * What lives in that block is the part that goes quietly wrong in a copy: the version comparison that decides
 * whether ~95 MB moves at all, the tag-pinned URL that makes resuming safe, the check that what landed is an
 * agent rather than a captive portal's login page, and the rule about which failures may keep a partial file.
 * A copy that drifts does not fail loudly — it just re-downloads 95 MB on every run again, on one card and not
 * the other, which is exactly the bug this block was written to end.
 *
 * The blocks are delimited by their own marker comments, in both dialects, so the check is the same rule for
 * shell and PowerShell rather than two extraction rules that can each be right about the wrong thing.
 */

const START = `# ---- the agent binary (identical in`;
const END = `# ---- end of the agent binary block ----`;

const script = (key: keyof typeof INSTALL_SCRIPTS): { readonly path: string; readonly text: string } => {
    const path = join(repoRoot(import.meta.url), INSTALL_SCRIPTS_DIR, INSTALL_SCRIPTS[key].file);
    return { path, text: readFileSync(path, "utf8") };
};

/** The marked block, or undefined when the script carries none — which is itself a failure for these four. */
const agentBlock = (text: string): string | undefined => {
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        return undefined;
    }
    return text.slice(start, end + END.length);
};

const PAIRS = [
    { dialect: `sh`, computer: `computerSh`, sync: `desktopSh` },
    { dialect: `PowerShell`, computer: `computerPs1`, sync: `desktopPs1` },
] as const satisfies readonly { dialect: string; computer: keyof typeof INSTALL_SCRIPTS; sync: keyof typeof INSTALL_SCRIPTS }[];

describe.each(PAIRS)(`the $dialect installers`, (pair) => {
    const both = [script(pair.computer), script(pair.sync)];

    it(`fetch the agent by one block, byte for byte the same in both`, () => {
        for (const one of both) {
            expect(agentBlock(one.text), `${one.path} carries no agent-binary block (its markers are missing or reordered)`).toEqual(
                expect.any(String),
            );
        }
        const [computer, sync] = both;
        expect(
            agentBlock(sync?.text ?? ``),
            `${sync?.path} and ${computer?.path} install the agent differently. These files cannot share code, so the copies have to be identical — fix the one that drifted rather than relaxing this test.`,
        ).toBe(agentBlock(computer?.text ?? ``));
    });

    /* The property the block exists for, stated as a property rather than as a diff: an installer that asks
     * neither question is one that downloads ~95 MB every time it runs, which is where all four started. */
    it(`decide by comparing the installed version against the published one`, () => {
        for (const { path, text } of both) {
            const block = agentBlock(text) ?? ``;
            expect(block, `${path} never asks the installed agent what version it is`).toMatch(/\bversion\b/);
            expect(block, `${path} never asks what the current release is`).toContain(`releases/latest`);
            expect(block, `${path} downloads without being able to resume`).toMatch(/--continue-at|AddRange/);
        }
    });
});
