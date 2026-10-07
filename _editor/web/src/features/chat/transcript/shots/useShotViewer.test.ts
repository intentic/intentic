// The pane's viewer state: it walks what the strips draw, set-aside pictures only for turns the reader revealed, and a
// tool card opening a set-aside picture reveals that turn rather than landing on a picture no strip shows.
import { ref } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { type ChatShot, shotKey } from "./shots";
import type { ChatTurn } from "../transcript";

const plain = new Set<string>();
jest.mock("./shotLooks", () => ({
    shotLook: (_agent: string | undefined, path: string) => ({ plain: plain.has(path), print: path }),
}));

const { useShotViewer } = await import("./useShotViewer");

const SHOTS = `${STATE_DIR}/records/artifacts/browser`;
const shotAt = (turnId: number, name: string): ChatShot => {
    const path = `${SHOTS}/${name}.png`;
    return { key: shotKey(name, path), path, toolId: name, turnId };
};

const [blank, page, later] = [shotAt(1, `blank`), shotAt(1, `page`), shotAt(2, `later`)];
const viewerOf = () =>
    useShotViewer(
        ref<ChatTurn[]>([]),
        ref(
            new Map([
                [1, [blank, page]],
                [2, [later]],
            ]),
        ),
        ref(undefined),
    );

beforeEach(() => {
    plain.clear();
    plain.add(blank.path);
});

describe(`useShotViewer`, () => {
    it(`walks only what the strips draw, and a turn's set-aside pictures once that turn is revealed`, () => {
        const viewer = viewerOf();
        expect(viewer.shots.value).toEqual([page, later]);
        viewer.reveal(1, true);
        expect(viewer.shots.value).toEqual([blank, page, later]);
        viewer.reveal(1, false);
        expect(viewer.shots.value).toEqual([page, later]);
    });

    it(`opening a set-aside picture from its tool card reveals its turn and opens there`, () => {
        const viewer = viewerOf();
        expect(viewer.viewCall(blank.toolId, blank.path)).toBe(true);
        expect(viewer.revealed.value.has(1)).toBe(true);
        expect(viewer.start.value).toBe(blank.key);
        expect(viewer.open.value).toBe(true);
    });

    it(`leaves a picture no strip holds to the card`, () => {
        expect(viewerOf().viewCall(`elsewhere`, `${SHOTS}/attached.png`)).toBe(false);
    });
});
