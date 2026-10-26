import type { LocalPcSetup } from "@intentic/web/local-host";
import { registerDesktopCatalog } from "../../i18n";
import { setupDetail, setupDoing } from "./setupLine";

// A running setup of this PC in the reader's words: the requirement it is on above the bar, and under it how the
// sandboxes' move stands, or ic's latest reading. The words are the English catalog's.

await registerDesktopCatalog();

type Running = Extract<LocalPcSetup, { readonly state: `running` }>;

const OPENING = `moving this PC's sandboxes to the intentic engine...`;
const running = (fields: Partial<Running> = {}): Running => ({ state: `running`, step: OPENING, percent: 50, ...fields });
const named = (slug: string): string => (slug === `work` ? `Shop` : slug);
// The bytes are one unbreakable run.
const run = (words: string): string => words.replaceAll(` `, `\u00a0`);

describe(`the line above the bar`, () => {
    it(`says the requirement in the app's words, not ic's sentence for it`, () => {
        expect(setupDoing(running({ row: `engine-move` }))).toBe(`Moving your sandboxes to Intentic's engine`);
        expect(setupDoing(running({ row: `wsl-features`, step: `turning on the Windows features Docker needs...` }))).toBe(
            `Turning on the Windows features agents need`,
        );
    });

    it(`keeps ic's sentence for a row this app has no words for, and before any row`, () => {
        expect(setupDoing(running({ row: `something-newer` }))).toBe(OPENING);
        expect(setupDoing(running())).toBe(OPENING);
    });
});

describe(`the line under the bar`, () => {
    it(`says which sandbox the move is on, of how many, its step and its bytes`, () => {
        const copying = running({ row: `engine-move`, moving: { slug: `work`, index: 1, count: 3, step: `volume`, done: 1_200_000_000, total: 3_400_000_000 } });
        expect(setupDetail(copying, named)).toBe(`Shop · sandbox 2 of 3 · Copying its files · ${run(`1.2 GB of 3.4 GB`)}`);
        // An image's size is ic's estimate, said as one; one sandbox is no position.
        const image = running({ row: `engine-move`, moving: { slug: `work`, index: 0, count: 1, step: `image`, done: 500_000_000, total: 2_000_000_000 } });
        expect(setupDetail(image, named)).toBe(`Shop · Copying its image · ${run(`0.5 GB of about 2.0 GB`)}`);
        const starting = running({ row: `engine-move`, moving: { slug: `notes`, index: 2, count: 3, step: `starting` } });
        expect(setupDetail(starting, named)).toBe(`notes · sandbox 3 of 3 · Starting it again`);
    });

    it(`says what the move waits on before its first sandbox`, () => {
        expect(setupDetail(running({ row: `engine-move`, moving: {} }), named)).toBe(`Looking at your sandboxes on Docker Desktop`);
        expect(setupDetail(running({ row: `engine-move`, moving: { slug: ``, step: `source` } }), named)).toBe(`Waiting for Docker Desktop to start`);
    });

    it(`is ic's latest reading of any other row, and nothing where it said no more than its first sentence`, () => {
        const reading = `still waiting for Docker's engine (120s before giving up)`;
        expect(setupDetail(running({ row: `docker-running`, reading }), named)).toBe(reading);
        expect(setupDetail(running({ row: `docker-running` }), named)).toBeUndefined();
    });
});
