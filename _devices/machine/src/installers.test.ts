import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_SCRIPTS, INSTALL_SCRIPTS_DIR } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";

// The four installers that put this agent on a machine, held to what little they still do. Each dialect's
// bootstrap block (curl|sh / irm|iex, standalone, no imports) still has to exist twice, and what goes wrong in
// a copy is the same short list: the tag-pinned URL, the resume, the probe. Every other decision (install vs.
// published, PATH, the Windows launcher) runs from `setup` (install.ts) instead.

const START = `# ---- bootstrap the agent binary (identical in`;
const END = `# ---- end of the agent binary bootstrap ----`;

const script = (key: keyof typeof INSTALL_SCRIPTS): { readonly path: string; readonly text: string } => {
    const path = join(repoRoot(import.meta.url), INSTALL_SCRIPTS_DIR, INSTALL_SCRIPTS[key].file);
    return { path, text: readFileSync(path, "utf8") };
};

/** The marked block, or undefined when the script carries none, itself a failure for these four. */
const bootstrapBlock = (text: string): string | undefined => {
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        return undefined;
    }
    return text.slice(start, end + END.length);
};

const PAIRS = [
    {
        dialect: `sh`,
        device: `deviceSh`,
        sync: `desktopSh`,
        declares: /^ROUTE="(?:device|sync)"$/mu,
        handsOver: /"\$ROUTE" setup/u,
        runnableStage: /chmod \+x "\$part"/u,
    },
    {
        dialect: `PowerShell`,
        device: `devicePs1`,
        sync: `desktopPs1`,
        declares: /^\$route = '(?:device|sync)'$/mu,
        handsOver: /@\(\$route, 'setup'/u,
        runnableStage: /^\s*\$part = "\$Dest\.part(?:-\$published)?\.exe"$/mu,
    },
] as const satisfies readonly {
    dialect: string;
    device: keyof typeof INSTALL_SCRIPTS;
    sync: keyof typeof INSTALL_SCRIPTS;
    declares: RegExp;
    handsOver: RegExp;
    runnableStage: RegExp;
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

    // The three properties a first download owes the machine: it resumes rather than restarts, it pins to the tag
    // it resolved (so a resume can never splice two releases), and it runs what landed before installing it.
    it(`download resumably, pinned to the resolved tag, and probe before installing`, () => {
        for (const { path, text } of both) {
            const block = bootstrapBlock(text) ?? ``;
            expect(block, `${path} downloads without being able to resume`).toMatch(/--continue-at|AddRange/);
            expect(block, `${path} never pins the download to the tag \`latest\` resolves to`).toContain(`releases/latest`);
            expect(block, `${path} never runs what it downloaded before installing it`).toMatch(/\bversion\b/);
        }
    });

    // And the staged file has to be runnable before it is probed, spelled differently per dialect: sh needs the
    // execute bit, PowerShell resolves a command by extension so the staged file needs a `.exe` name.
    it(`make the staged download runnable before probing it`, () => {
        for (const { path, text } of both) {
            expect(
                bootstrapBlock(text) ?? ``,
                `${path} probes a staged download this dialect will not run (sh needs chmod +x, PowerShell needs a .exe name)`,
            ).toMatch(pair.runnableStage);
        }
    });

    // The property that survives a route rename, the one decision the shims cannot delegate: their handover is
    // itself part of the agent's vocabulary, so an installed agent older than that vocabulary cannot take it. Each
    // shim asks first (`<route> setup --help`) and only replaces an agent that can answer.
    it(`ask whether the installed agent understands the handover, and name the route once`, () => {
        for (const { path, text } of both) {
            expect(bootstrapBlock(text) ?? ``, `${path} hands over without asking whether the installed agent understands it`).toContain(
                `setup --help`,
            );
            expect(text, `${path} does not name its route once, above the bootstrap block`).toMatch(pair.declares);
            expect(text, `${path} spells the route again at the handover instead of using the one it declared`).toMatch(pair.handsOver);
        }
    });

    // The property the shims exist for: decisions stay in the agent. The probe here only asks whether an agent can
    // take the handover, never which build is newer.
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
