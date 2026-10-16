import { STATE_DIR } from "@intentic/constants";
import { reachLine } from "./reachLine";

// No mocks: the line is a pure projection of where the last turn put its work besides its branch, in the board's words.
const AT = 1_700_000_000_000;

describe(`reachLine`, () => {
    it(`says nothing for a turn whose work stayed on its branch`, () => {
        expect(reachLine(undefined)).toBeUndefined();
        expect(reachLine({ at: AT })).toBeUndefined();
    });

    it(`names the extension whose installed copy it changed, as a warning`, () => {
        expect(
            reachLine({ at: AT, live: [{ path: `${STATE_DIR}/local/extensions/intentic-maintenance`, extension: `intentic.maintenance` }] }),
        ).toEqual({
            text: `Changed the installed copy of intentic.maintenance: live now, not reviewed, lost on its next update`,
            tone: `warning`,
            detail: `Changed the installed copy of intentic.maintenance: live now, not reviewed, lost on its next update`,
        });
    });

    it(`counts the other files it wrote outside its branch, those left off the list included, and lists them in the hover`, () => {
        const line = reachLine({
            at: AT,
            live: [{ path: `${STATE_DIR}/local/state.json` }, { path: `/mnt/intentic-main/intentic/src/a.ts` }],
            liveMore: 1,
        });
        expect(line?.text).toBe(`Wrote 3 files outside its branch: live now, not reviewed`);
        expect(line?.detail).toBe(
            [
                `Wrote 3 files outside its branch: live now, not reviewed`,
                `  .intentic/local/state.json`,
                `  /mnt/intentic-main/intentic/src/a.ts`,
            ].join(`\n`),
        );
        expect(reachLine({ at: AT, live: [{ path: `${STATE_DIR}/local/state.json` }] })?.text).toBe(
            `Wrote 1 file outside its branch: live now, not reviewed`,
        );
    });

    it(`says what a clone of its own holds that will not land`, () => {
        expect(reachLine({ at: AT, stranded: [{ dir: `extensions/widgets`, uncommitted: 3, unpushed: 0 }] })?.text).toBe(
            `3 uncommitted changes in extensions/widgets, a clone of its own: they won't land`,
        );
        expect(reachLine({ at: AT, stranded: [{ dir: `fork`, uncommitted: 0, unpushed: 1 }] })?.text).toBe(
            `1 commit not pushed in fork, a clone of its own: it won't land`,
        );
        expect(reachLine({ at: AT, stranded: [{ dir: `fork`, uncommitted: 2, unpushed: 4 }] })).toMatchObject({
            text: `2 uncommitted changes and 4 commits not pushed in fork, a clone of its own: they won't land`,
            tone: `warning`,
        });
    });

    it(`says where a push went, neutrally, as far as the command named it`, () => {
        expect(
            reachLine({ at: AT, published: [{ dir: `extensions/widgets`, remote: `origin`, branch: `main`, command: `git push origin main` }] }),
        ).toEqual({
            text: `Pushed to origin/main from extensions/widgets`,
            tone: `neutral`,
            detail: `Pushed to origin/main from extensions/widgets`,
        });
        expect(reachLine({ at: AT, published: [{ remote: `origin`, command: `git push origin` }] })?.text).toBe(`Pushed to origin`);
        expect(reachLine({ at: AT, published: [{ command: `git push` }] })?.text).toBe(`Pushed to its upstream`);
    });

    it(`leads with the worst of several, counts the rest, and lists every one in the hover`, () => {
        const line = reachLine({
            at: AT,
            live: [{ path: `${STATE_DIR}/local/extensions/intentic-x`, extension: `intentic.x` }],
            stranded: [{ dir: `fork`, uncommitted: 1, unpushed: 0 }],
            published: [{ command: `git push` }],
            publishedMore: 2,
        });
        expect(line?.text).toBe(`Changed the installed copy of intentic.x: live now, not reviewed, lost on its next update (+3 more)`);
        expect(line?.tone).toBe(`warning`);
        expect(line?.detail.split(`\n`)).toEqual([
            `Changed the installed copy of intentic.x: live now, not reviewed, lost on its next update`,
            `1 uncommitted change in fork, a clone of its own: it won't land`,
            `Pushed to its upstream`,
            `2 more pushes`,
        ]);
    });
});
