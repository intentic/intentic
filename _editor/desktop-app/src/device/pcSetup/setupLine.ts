import { t } from "@intentic/ui/i18n";
import type { LocalPcMove, LocalPcSetup } from "@intentic/web/local-host";
import { copiedWords, positionWords, stepWords } from "../engine/moveWords";

// A RUNNING SETUP OF THIS PC, IN THE READER'S WORDS (PcSetupRunning.vue draws it; 2026-10-26). ic says what it does in
// sentences of its own (prepare/mod.rs `apply`), which the line above the bar showed as they came: "moving this PC's
// sandboxes to the intentic engine..." on a Polish screen, over a bar that did not move for the whole move. The line is
// now the requirement the setup is on, in this app's words; under the bar, how the sandboxes' move stands while that is
// the row (which one, its step, its bytes, every two seconds), else ic's latest reading where it said more than its first.

type Running = Extract<LocalPcSetup, { readonly state: `running` }>;

const NO_BREAK = `\u00a0`;

/** The line above the bar: the requirement it is on, else ic's own sentence for one this app has no words for. */
export const setupDoing = (setup: Running): string | undefined => {
    if (setup.row === undefined) {
        return setup.step;
    }
    const said = t(`desktop.pcSetup.doing.${setup.row}`);
    return said === `desktop.pcSetup.doing.${setup.row}` ? setup.step : said;
};

/** The line under the bar: how the sandboxes' move stands, or ic's latest reading of the row. */
export const setupDetail = (setup: Running, nameOf: (slug: string) => string): string | undefined =>
    setup.moving === undefined ? setup.reading : moveDetail(setup.moving, nameOf);

const moveDetail = (moving: LocalPcMove, nameOf: (slug: string) => string): string => {
    // Before any sandbox: Docker Desktop started to read them, our engine installed first, or their sizes being read.
    if (moving.slug === undefined || moving.slug === ``) {
        return stepWords(moving.step) ?? t(`desktop.pcSetup.moving.reading`);
    }
    // The bytes kept on one line, so a narrow window breaks between the parts and never inside "1.2 GB of 3.4 GB".
    const copied = copiedWords(moving.step, moving.done, moving.total)?.replaceAll(` `, NO_BREAK);
    return [nameOf(moving.slug), positionWords(moving.index, moving.count), stepWords(moving.step), copied]
        .filter((part): part is string => part !== undefined && part !== ``)
        .join(` · `);
};
