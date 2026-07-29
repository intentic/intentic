// @vitest-environment jsdom
//
// jsdom because what this component IS is what it renders: a refused land's causes, grouped, each one saying
// who can clear it. The two guarantees pinned here are the ones a reader of the code cannot check — that the
// report and the file list below it name a cause in ONE vocabulary (REASON_COPY, shared), and that every path
// it prints is a control that hands its ROW back rather than a string the user has to match by eye.
import type { LandConflict } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import { REASON_COPY } from "../composables/agents/conflictResolution";

// The component's import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic-app/ui's useDevice reads window.matchMedia; environment.ts reads window.env). vi.hoisted runs
// before the imports evaluate. matches:false keeps the device DESKTOP, where the report's ladder is complete.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

const { default: AgentConflictReport } = await import("./AgentConflictReport.vue");

// All three causes at once, across two repos — the shape that makes every branch of the report render, and the
// one where a bare path is ambiguous (docs/README.md is a row in `docs`, not in `root`).
const conflicts: readonly LandConflict[] = [
    {
        repo: `root`,
        clean: 11,
        paths: [
            { path: `src/auth/session.ts`, reason: `diverged` },
            { path: `assets/logo.png`, reason: `binary` },
            { path: `src/config.ts`, reason: `workspace` },
        ],
    },
    { repo: `docs`, clean: 2, paths: [{ path: `README.md`, reason: `diverged` }] },
];

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin. Icon
// prints the glyph it was handed, because WHICH glyph is under test — it is the link between a group heading
// here and the marks on the rows below.
const mount = (): { el: HTMLElement; selected: unknown[] } => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const selected: unknown[] = [];
    app = createApp({
        render: () =>
            h(AgentConflictReport, {
                conflicts,
                streaming: false,
                busy: false,
                asked: false,
                onSelect: (blocker: unknown) => selected.push(blocker),
            }),
    });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return { el, selected };
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const pathButtons = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll(`button`)].filter((button) => button.className.includes(`font-mono`));

it(`says each cause in the words and the glyph the file list marks those rows with`, () => {
    const { el } = mount();
    // Not a copy of the strings — a comparison against the module both surfaces read, so a reworded cause
    // cannot leave the report and the rows disagreeing about the same refusal.
    for (const reason of [`diverged`, `workspace`, `binary`] as const) {
        expect(el.textContent).toContain(REASON_COPY[reason].title);
        expect(el.textContent).toContain(REASON_COPY[reason].fix);
        expect(el.querySelector(`[data-icon="${REASON_COPY[reason].icon}"]`)).not.toBeNull();
    }
});

it(`hands back the row a path names, repo and all — a label alone cannot be taken apart again`, () => {
    const { el, selected } = mount();
    const nested = pathButtons(el).find((button) => button.textContent?.trim() === `docs/README.md`)!;
    nested.click();
    expect(selected).toEqual([{ repo: `docs`, path: `README.md`, reason: `diverged` }]);
});

it(`makes every blocked path a control, so no listed file is a dead string to hunt for`, () => {
    const { el } = mount();
    expect(pathButtons(el).map((button) => button.textContent?.trim())).toEqual([
        `src/auth/session.ts`,
        `docs/README.md`,
        `src/config.ts`,
        `assets/logo.png`,
    ]);
});
