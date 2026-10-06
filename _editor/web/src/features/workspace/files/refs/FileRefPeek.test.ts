import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceFile } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { type App, createApp, h, nextTick } from "vue";

// The preview a transcript's file links raise, driven through the real component: the links live in v-html, so every
// rule here is about delegated pointer, focus and key events on the surface, which a caller never sees. The reading
// rules themselves are fileRefQuickLook.test.ts's.

const reads: string[] = [];
let answer: (path: string) => WorkspaceFile = (path) => ({ present: false, path });
jest.mock("../fileWindow", () => ({
    readFileWindow: (path: string) => {
        reads.push(path);
        return Promise.resolve(answer(path));
    },
}));
jest.mock("./resolveFileRef", () => ({ resolveWorkspaceRef: () => Promise.resolve(undefined) }));
const opened: unknown[][] = [];
jest.mock("./openFileRef", () => ({
    openWorkspaceRef: (...args: unknown[]) => {
        opened.push(args);
        return Promise.resolve();
    },
    sharedStatePath: (path: string) => path.startsWith(`${STATE_DIR}/`),
}));
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: { workspace: { children: () => Promise.resolve({ entries: [], hidden: 0 }) } },
}));

const { default: FileRefPeek } = await import("./FileRefPeek.vue");

// A plain-text file, so no grammar loads under the test: 30 numbered lines.
const PLAN = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join(`\n`);
const planWindow = (path: string): WorkspaceFile =>
    path === `notes/plan.txt`
        ? { present: true, path, content: PLAN, size: PLAN.length, offset: 0, bytes: PLAN.length, shared: true }
        : { present: false, path };

let app: App | undefined;

// A transcript holding one rendered file link, the way markdownFileLinks.ts marks it, and the preview listening on it.
const mount = async (file = `notes/plan.txt`, line = `5`): Promise<{ link: HTMLAnchorElement; host: HTMLElement }> => {
    const host = document.createElement(`div`);
    host.innerHTML = `<p>See <a class="md-file-link" href="/workspace/${file}" data-file="${file}" data-line="${line}" title="${file}:${line}">x</a> first.</p>`;
    document.body.append(host);
    const link = host.querySelector(`a`)!;
    // The overlay closes on an anchor with no size, which is every element in a DOM that lays nothing out.
    link.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 400, width: 60, height: 16 });
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(FileRefPeek, { host }) });
    // Registered globally by the app's boot, which a component test does not run.
    app.component(`Icon`, Icon);
    app.mount(root);
    await nextTick();
    return { link, host };
};

// Every promise the open path chains through: the reads, the overlay's own tick and the render its placement queues.
const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
    }
    await nextTick();
};

const card = (): HTMLElement | null => document.querySelector<HTMLElement>(`.ui-anchored`);
const over = (link: HTMLElement, pointerType = `mouse`): boolean =>
    link.dispatchEvent(new PointerEvent(`pointerover`, { bubbles: true, pointerType }));
const out = (link: HTMLElement): boolean => link.dispatchEvent(new PointerEvent(`pointerout`, { bubbles: true, pointerType: `mouse` }));

beforeEach(() => {
    jest.useFakeTimers();
    reads.length = 0;
    opened.length = 0;
    answer = planWindow;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    jest.useRealTimers();
});

it(`opens only for a pointer that stays, on the named line among its neighbours`, async () => {
    const { link } = await mount();
    over(link);
    jest.advanceTimersByTime(349);
    await settle();
    expect(card()).toBeNull();

    jest.advanceTimersByTime(1);
    await settle();
    // Each row as its number and its code.
    const rows = [...(card()?.querySelectorAll<HTMLElement>(`[data-peek-line]`) ?? [])].map((row) =>
        [...row.children].map((cell) => cell.textContent?.trim()),
    );
    expect(card()?.textContent).toContain(`notes/plan.txt:5`);
    expect(card()?.textContent).toContain(`30 lines`);
    expect(rows).toEqual(Array.from({ length: 12 }, (_, index) => [`${index + 2}`, `line ${index + 2}`]));
    expect(card()?.querySelector(`[data-peek-marked]`)?.getAttribute(`data-peek-line`)).toBe(`5`);
    // Read once, on the shorter dwell, before the card was up.
    expect(reads).toEqual([`notes/plan.txt`]);
});

it(`keeps the card while the pointer crosses into it, and closes once it has left both`, async () => {
    const { link } = await mount();
    over(link);
    jest.advanceTimersByTime(350);
    await settle();
    // The link's own title would raise the browser's tooltip over the card; it is off while the pointer is on the link.
    expect(link.getAttribute(`title`)).toBeNull();

    out(link);
    jest.advanceTimersByTime(100);
    const surface = card()?.querySelector<HTMLElement>(`[data-peek-card]`);
    surface?.dispatchEvent(new PointerEvent(`pointerenter`, { pointerType: `mouse` }));
    jest.advanceTimersByTime(1000);
    await settle();
    expect(card()).not.toBeNull();
    expect(link.getAttribute(`title`)).toBe(`notes/plan.txt:5`);

    surface?.dispatchEvent(new PointerEvent(`pointerleave`, { pointerType: `mouse` }));
    jest.advanceTimersByTime(149);
    await settle();
    expect(card()).not.toBeNull();
    jest.advanceTimersByTime(1);
    await settle();
    expect(card()).toBeNull();
});

it(`takes Escape for itself while up, so the page's own Escape does not also fire`, async () => {
    const { link } = await mount();
    let heard = 0;
    document.body.addEventListener(`keydown`, (event) => {
        heard += event.key === `Escape` ? 1 : 0;
    });
    over(link);
    jest.advanceTimersByTime(350);
    await settle();
    document.body.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
    await settle();
    expect([card(), heard]).toEqual([null, 0]);

    document.body.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
    expect(heard).toBe(1);
});

it(`opens the file where the link would when the card is pressed`, async () => {
    const { link } = await mount();
    over(link);
    jest.advanceTimersByTime(350);
    await settle();
    card()?.querySelector<HTMLElement>(`[data-peek-card]`)?.click();
    await settle();
    expect(opened).toEqual([[`notes/plan.txt`, 5, { agent: undefined }]]);
    expect(card()).toBeNull();
});

it(`says a path with nothing at it has nothing there`, async () => {
    const { link } = await mount(`notes/gone.txt`, `3`);
    over(link);
    jest.advanceTimersByTime(350);
    await settle();
    expect(card()?.textContent).toContain(`Nothing at this path.`);
});

it(`raises nothing for a touch, whose tap is the click that opens the file`, async () => {
    const { link } = await mount();
    over(link, `touch`);
    jest.advanceTimersByTime(1000);
    await settle();
    expect([card(), reads.length, link.getAttribute(`title`)]).toEqual([null, 0, `notes/plan.txt:5`]);
});
