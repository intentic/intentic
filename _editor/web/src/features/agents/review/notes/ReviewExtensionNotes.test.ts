// jsdom because the subject is what each line says: a land is the yes to the workspace extensions it carries, so the
// review names each one and what it may do before the press.
import "@intentic/testing/dom";
import type { LandingExtensions } from "@intentic/sandbox-contract/schemas/agents";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: ReviewExtensionNotes } = await import("./ReviewExtensionNotes.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

const lines = async (extensions: LandingExtensions): Promise<string[]> => {
    host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(ReviewExtensionNotes, { extensions }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return [...host.querySelectorAll(`span`)].map((span) => (span.textContent ?? ``).trim());
};

afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
});

test(`a new extension, one asking for more, and one asking for nothing new each say what landing does`, async () => {
    expect(
        await lines([
            { id: `acme.toolbox`, dir: `toolbox`, powers: [`calls GET /panels`, `runs a UI bundle in your browser`], approvedBefore: false },
            { id: `acme.grower`, dir: `grower`, powers: [`calls POST /panels/*/start`], approvedBefore: true },
            { id: `acme.smaller`, dir: `smaller`, powers: [], approvedBefore: true },
        ]),
    ).toEqual([
        `Landing turns on the extension acme.toolbox, which can: calls GET /panels; runs a UI bundle in your browser`,
        `Landing lets the extension acme.grower also: calls POST /panels/*/start`,
        `Landing turns the extension acme.smaller back on, asking for nothing new.`,
    ]);
});

test(`work that turns no extension on says nothing`, async () => {
    expect(await lines([])).toEqual([]);
});
