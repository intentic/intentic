import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_SCRIPTS, INSTALL_SCRIPTS_DIR } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";

/* THE FOUR INSTALLERS THAT PUT THIS AGENT ON A MACHINE, HELD TO WHAT LITTLE THEY STILL DO.
 *
 * `device.sh`, `sync.sh`, `device.ps1` and `sync.ps1` are bootstrap shims: they download an agent onto a
 * machine that has none — or has one that cannot take their handover — and exec `setup`. Every decision they
 * used to make — installed-vs-published, PATH, the Windows launcher — runs from `setup` itself now
 * (install.ts), so those rules are held by install.test.ts and the compiler rather than by string-matching
 * shell.
 *
 * What still has to exist twice per dialect (each file is handed to `curl | sh` or `irm | iex` as one
 * standalone string — no import, no dot-sourcing) is the bootstrap block, and what still goes quietly wrong
 * in a copy is the same short list as before: the tag-pinned URL that makes resuming safe, the resume itself,
 * and the probe that separates an agent from a captive portal's login page. The blocks are delimited by their
 * own marker comments, in both dialects, so the check is one rule for shell and PowerShell. */

const START = `# ---- bootstrap the agent binary (identical in`;
const END = `# ---- end of the agent binary bootstrap ----`;

const script = (key: keyof typeof INSTALL_SCRIPTS): { readonly path: string; readonly text: string } => {
    const path = join(repoRoot(import.meta.url), INSTALL_SCRIPTS_DIR, INSTALL_SCRIPTS[key].file);
    return { path, text: readFileSync(path, "utf8") };
};

/** The marked block, or undefined when the script carries none — which is itself a failure for these four. */
const bootstrapBlock = (text: string): string | undefined => {
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        return undefined;
    }
    return text.slice(start, end + END.length);
};

const PAIRS = [
    { dialect: `sh`, device: `deviceSh`, sync: `desktopSh`, declares: /^ROUTE="(?:device|sync)"$/mu, handsOver: /"\$ROUTE" setup/u },
    {
        dialect: `PowerShell`,
        device: `devicePs1`,
        sync: `desktopPs1`,
        declares: /^\$route = '(?:device|sync)'$/mu,
        handsOver: /@\(\$route, 'setup'/u,
    },
] as const satisfies readonly {
    dialect: string;
    device: keyof typeof INSTALL_SCRIPTS;
    sync: keyof typeof INSTALL_SCRIPTS;
    declares: RegExp;
    handsOver: RegExp;
}[];

describe.each(PAIRS)(`the $dialect installers`, (pair) => {
    const both = [script(pair.device), script(pair.sync)];

    it(`bootstrap the agent by one block, byte for byte the same in both`, () => {
        for (const one of both) {
            expect(bootstrapBlock(one.text), `${one.path} carries no bootstrap block (its markers are missing or reordered)`).toEqual(
                expect.any(String),
            );
        }
        const [device, sync] = both;
        expect(
            bootstrapBlock(sync?.text ?? ``),
            `${sync?.path} and ${device?.path} bootstrap the agent differently. These files cannot share code, so the copies have to be identical — fix the one that drifted rather than relaxing this test.`,
        ).toBe(bootstrapBlock(device?.text ?? ``));
    });

    /* The three properties a first download owes the machine, stated as properties rather than as a diff: it
     * resumes rather than restarts (95 MB on a flaky connection), it pins to the tag it resolved (so a resume
     * can never splice two releases), and it runs what landed before installing it (the only proof a file is
     * an agent rather than a captive portal's answer). */
    it(`download resumably, pinned to the resolved tag, and probe before installing`, () => {
        for (const { path, text } of both) {
            const block = bootstrapBlock(text) ?? ``;
            expect(block, `${path} downloads without being able to resume`).toMatch(/--continue-at|AddRange/);
            expect(block, `${path} never pins the download to the tag \`latest\` resolves to`).toContain(`releases/latest`);
            expect(block, `${path} never runs what it downloaded before installing it`).toMatch(/\bversion\b/);
        }
    });

    /* THE PROPERTY THAT SURVIVES A ROUTE RENAME, which is the one decision the shims cannot delegate: their
     * handover is itself part of the agent's vocabulary, so an installed agent older than that vocabulary
     * cannot take it — and the self-update that would have replaced it sits behind the very command it does
     * not understand. `computer` -> `device` cost every already-paired machine exactly that: the card's own
     * command answered "No command registered for `device`", and nothing short of deleting the binary by hand
     * got past it.
     *
     * So each shim ASKS before it hands over — `<route> setup --help`, which prints a usage screen and
     * connects nothing — and replaces an agent that cannot answer. The route is named once per file, above the
     * block, because a probe and a handover that disagree is the same bug in a new hat. */
    it(`ask whether the installed agent understands the handover, and name the route once`, () => {
        for (const { path, text } of both) {
            expect(bootstrapBlock(text) ?? ``, `${path} hands over without asking whether the installed agent understands it`).toContain(
                `setup --help`,
            );
            expect(text, `${path} does not name its route once, above the bootstrap block`).toMatch(pair.declares);
            expect(text, `${path} spells the route again at the handover instead of using the one it declared`).toMatch(pair.handsOver);
        }
    });

    /* The property the shims exist for: the DECISIONS stay in the agent. A script that grows an
     * installed-vs-published comparison, a force-download switch, or an npx fallback is a script on its way
     * back to being four copies of install.ts in two dialects — the design this rewrite retired. The probe
     * above is not that comparison: it asks whether an agent can take the handover, never which build is
     * newer, and it is answered by running the agent rather than by reading a version out of it. */
    it(`leave every decision beyond the first download to \`setup\``, () => {
        for (const { path, text } of both) {
            expect(text, `${path} carries a force-download switch; deleting the installed binary is the way to force a reinstall`).not.toContain(
                `FORCE_DOWNLOAD`,
            );
            expect(text, `${path} grew a second install channel (npx); the GitHub release is the one channel`).not.toMatch(/\bnpx\b/);
            expect(text, `${path} never hands over to setup`).toMatch(/\bsetup\b/);
        }
    });
});
