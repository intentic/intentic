// api.sideViews at the host's grain: what the manifest must declare, what an extension may open, and which of its links
// the chat hands it. Built against the real createExtensionApi, as the conformance suite does.
import "@intentic/testing/dom";
import type { IntenticApi, SideViewInput, SideViewRegistration } from "@intentic/extension-api";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-manifest";
import { defineComponent, h } from "vue";

// Where "Open in …" and a phone's fallback go, stood in for: the route itself is the router's business.
const push = jest.fn((_path: string) => Promise.resolve());
jest.mock("../../router/index", () => ({
    router: { push, currentRoute: { value: { name: `agents` } }, resolve: (path: string) => ({ href: path, fullPath: path }) },
}));

const { createExtensionApi, deactivateExtension } = await import("../apiImpl");
const { claimLink, describeTab, homeOf, sideViewOf } = await import("../../workbench/side/sideViews");
const { closeAllTabs, sideDocked, sideTabId, useSidePanel } = await import("../../workbench/side/sideTabs");

const panel = useSidePanel();

const manifestWith = (sideViews: readonly Record<string, unknown>[]): ExtensionManifest =>
    ExtensionManifestSchema.parse({
        publisher: `acme`,
        name: `ci`,
        version: `1.0.0`,
        engines: { intentic: `^2.22.0` },
        entry: `dist/extension.js`,
        contributes: { sideViews },
    });

const apiOf = (manifest: ExtensionManifest): IntenticApi =>
    createExtensionApi({ id: `acme.ci`, manifest, commit: `test`, source: `builtin`, enabled: true }, { repos: () => [], capabilities: () => [] })
        .api;

// How a bundle never compiled against this SDK calls `open`: with whatever it holds as the input.
interface UntypedSideViews {
    open(id: string, input: unknown): void;
}

const Body = defineComponent({ setup: () => () => h(`p`, `run`) });
const runOf = (input: SideViewInput): number => Number(input[`runId`]);
const RUN: SideViewRegistration = {
    id: `run`,
    describe: (input) => ({ title: `#${runOf(input)}`, icon: `pipelines`, tooltip: `Run ${runOf(input)} of build` }),
    home: (input) => `/ext/ci?run=${runOf(input)}`,
    claim: (url) => {
        const id = /\/actions\/runs\/(\d+)/u.exec(url)?.[1];
        return id === undefined ? undefined : { runId: Number(id) };
    },
    view: async () => Body,
};
const RUN_URL = `https://github.com/acme/web/actions/runs/42`;

beforeEach(() => {
    push.mockClear();
    sideDocked.value = true;
    closeAllTabs();
});

afterEach(() => {
    deactivateExtension(`acme.ci`);
    sideDocked.value = false;
});

it(`refuses a side view the manifest does not declare`, () => {
    const api = apiOf(manifestWith([]));
    expect(() => api.sideViews.register(RUN)).toThrow(`side view "run" is not declared in the manifest's contributes.sideViews`);
});

it(`draws a declared side view under the extension's own id, its tab in the extension's words`, () => {
    apiOf(manifestWith([{ id: `run`, label: `CI run` }])).sideViews.register(RUN);
    const tab = { id: sideTabId(`acme.ci/run`, { runId: 7 }), view: `acme.ci/run`, input: { runId: 7 } };

    expect(sideViewOf(`acme.ci/run`)?.label).toBe(`CI run`);
    expect(describeTab(tab)).toEqual({ title: `#7`, icon: `pipelines`, tip: { title: `#7`, note: `Run 7 of build` } });
    homeOf(tab)?.open();
    expect(push).toHaveBeenCalledWith(`/ext/ci?run=7`);
});

it(`takes the chat's links only where the manifest says it may`, () => {
    apiOf(manifestWith([{ id: `run`, label: `CI run` }])).sideViews.register(RUN);
    expect(claimLink(RUN_URL)).toBeUndefined();
    deactivateExtension(`acme.ci`);

    apiOf(manifestWith([{ id: `run`, label: `CI run`, links: true }])).sideViews.register(RUN);
    expect(claimLink(RUN_URL)).toEqual({ view: `acme.ci/run`, input: { runId: 42 } });
    expect(claimLink(`https://github.com/acme/web/pulls/3`)).toBeUndefined();
});

it(`opens its own side view beside, as a peek unless kept, and nothing it has no claim to`, () => {
    const api = apiOf(manifestWith([{ id: `run`, label: `CI run` }]));
    api.sideViews.register(RUN);

    api.sideViews.open(`run`, { runId: 7 });
    expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ runId: 7 }]);
    expect(panel.peek.value).toBe(sideTabId(`acme.ci/run`, { runId: 7 }));

    api.sideViews.open(`run`, { runId: 8 }, { keep: true });
    expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ runId: 7 }, { runId: 8 }]);

    // Undeclared, and an input that is not plain values: neither could survive a reload as a tab. A bundle's call arrives
    // untyped at runtime, so the second is made the way a bundle could make it, past the type.
    api.sideViews.open(`other`, { runId: 9 });
    const bundle: UntypedSideViews = api.sideViews;
    bundle.open(`run`, { runId: { nested: 9 } });
    expect(panel.tabs.value).toHaveLength(2);
});

it(`goes to the side view's home where there is no side panel`, () => {
    sideDocked.value = false;
    const api = apiOf(manifestWith([{ id: `run`, label: `CI run` }]));
    api.sideViews.register(RUN);

    api.sideViews.open(`run`, { runId: 7 });
    expect(push).toHaveBeenCalledWith(`/ext/ci?run=7`);
    expect(panel.tabs.value).toEqual([]);
});

it(`takes its side views with it when it deactivates`, () => {
    apiOf(manifestWith([{ id: `run`, label: `CI run`, links: true }])).sideViews.register(RUN);
    deactivateExtension(`acme.ci`);

    expect(sideViewOf(`acme.ci/run`)).toBeUndefined();
    expect(claimLink(RUN_URL)).toBeUndefined();
});
