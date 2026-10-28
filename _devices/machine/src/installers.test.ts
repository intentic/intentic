import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_SCRIPTS, INSTALL_SCRIPTS_DIR } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";

// The four installers that put this agent on a machine, held to what little they still do. Each dialect's
// bootstrap block (curl|sh / irm|iex, standalone, no imports) still has to exist twice. The staged executable
// must also be runnable before it is probed. Other install decisions run from `setup` (install.ts).

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
        runnableStage: /chmod \+x "\$part"/u,
    },
    {
        dialect: `PowerShell`,
        device: `devicePs1`,
        sync: `desktopPs1`,
        runnableStage: /^\s*\$part = "\$Dest\.part(?:-\$published)?\.exe"$/mu,
    },
] satisfies {
    dialect: string;
    device: keyof typeof INSTALL_SCRIPTS;
    sync: keyof typeof INSTALL_SCRIPTS;
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
});
