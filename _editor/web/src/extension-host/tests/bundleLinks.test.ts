import "@intentic/testing/dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { RepoRail } from "@intentic/extension-ui";
import { extensionUiDeprecated } from "@intentic/extension-ui/names";
import { createApp, h, nextTick, ref } from "vue";
import { bundleLinkProblem, HOST_EXPORTS } from "../bundleLinks";

// The loader's check of a bundle's imports, before import() links it (loader.ts): what a bundle asks of the host
// against what the host's shims export.

const shimExports = (file: string): string[] =>
    [...readFileSync(join(packageRoot(import.meta.url), `public/ext-shims`, file), `utf8`).matchAll(/^export const (\w+) =/gmu)].map(
        (match) => match[1] ?? ``,
    );

// The head of intentic.maintenance's bundle at the revision a sandbox still ran on 2026-10-15, built against the kit
// before RepoRail left it.
const MAINTENANCE_HEAD = [
    `import { hostSlot as e, sandboxLedger as t, sandboxPoll as n } from "@intentic/extension-api";`,
    `import { computed as i, ref as ee } from "vue";`,
    `import { AgentRunButton as re, Button as ie, DisclosureRow as ae, Icon as oe, Notice as se, PageAction as ce, ProjectChip as le, ` +
        `RepoRail as ue, RowGroup as de, SegmentedControl as fe, SplitView as pe, StatusBadge as me, freshness as he, noticeOf as ge, ` +
        `timeAgo as _e, ui as ve, useAgentRunPick as ye, useNow as be } from "@intentic/extension-ui";`,
    `import { useQuery as we } from "@tanstack/vue-query";`,
    `//#region \0rolldown/runtime.js`,
    `var Ee = Object.defineProperty;`,
].join(`\n`);

test(`what the check holds a bundle to is what the shims export`, () => {
    expect(HOST_EXPORTS[`@intentic/extension-ui`]?.toSorted()).toEqual(shimExports(`extension-ui.js`));
    expect(HOST_EXPORTS[`@intentic/extension-api`]?.toSorted()).toEqual(shimExports(`extension-api.js`));
});

test(`a bundle built against RepoRail links again`, () => {
    expect(bundleLinkProblem(MAINTENANCE_HEAD)).toBeUndefined();
});

test(`a name the host lacks is said in words, with the fix`, () => {
    const source = `import{RepoRail as a,Gone as b}from"@intentic/extension-ui";import{sandboxPoll as c,retired as d}from"@intentic/extension-api";`;
    expect(bundleLinkProblem(source)).toBe(
        `needs Gone from @intentic/extension-ui; retired from @intentic/extension-api, which this version of the app doesn't have: ` +
            `the extension was built for a different version and needs updating`,
    );
});

test(`an import the host does not judge is left to the browser`, () => {
    expect(bundleLinkProblem(`import{definitelyNotVue as a}from"vue";`)).toBeUndefined();
});

describe(`RepoRail, restored for the extensions built against it`, () => {
    test(`is exported by the kit and its shim, declared deprecated in favour of RepoPicker`, () => {
        expect(shimExports(`extension-ui.js`)).toContain(`RepoRail`);
        expect(extensionUiDeprecated.find((entry) => entry.name === `RepoRail`)).toMatchObject({ use: `RepoPicker`, removableIn: `3.0.0` });
    });

    test(`draws the pinned row and one row per repository, and a press narrows to it`, async () => {
        const host = document.createElement(`div`);
        document.body.append(host);
        const picked = ref<string | undefined>(undefined);
        const app = createApp({
            render: () =>
                h(RepoRail, {
                    groups: [{ key: `repos`, rows: [{ value: `api`, label: `api`, icon: `folder`, meta: `2 due` }] }],
                    all: { icon: `folder`, meta: `2 due` },
                    memory: `bundle-links-test`,
                    modelValue: picked.value,
                    "onUpdate:modelValue": (value: string | undefined) => (picked.value = value),
                }),
        });
        app.mount(host);
        const buttons = [...host.querySelectorAll(`button`)];
        // A row's title and its number sit in separate cells, so the text runs them together.
        expect(buttons.map((button) => button.textContent?.trim())).toEqual([`All repositories2 due`, `api2 due`]);
        buttons[1]?.click();
        await nextTick();
        expect(picked.value).toBe(`api`);
        app.unmount();
        host.remove();
    });
});
