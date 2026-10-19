import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { SETTINGS_CARDS, settingsPages, settingsPageTerms } from "../../features/settings/settingsIndex";
import { SETTINGS_DEFAULT_SECTION, settingsSections } from "../../features/settings/settingsNav";
import { SANDBOX_CARDS, sandboxPageTerms } from "../../models/sandbox/sandboxIndex";
import { sandboxBuiltInSlugs, sandboxSections } from "../../models/sandbox/sandboxNav";
import { groupByHub, type HubReader, type HubSource, searchHubs, settingHash, settingOfHash, type SettingEntry } from "./hubSearch";

// FINDING A SETTING BY NAME. The two halves of an answer live apart: the index tables say a card exists and what it is
// called, the card's own template carries the mark an answer lands on. So this holds them to each other by reading the
// templates as text, both ways, and holds every entry to a page and a category that exist; then it asks the real
// tables, in English, the questions people type.

const SRC = join(packageRoot(import.meta.url), `src`);

const vueFiles = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === `node_modules` ? [] : vueFiles(path);
        }
        return entry.name.endsWith(`.vue`) ? [path] : [];
    });

// Every `data-setting` written in a template, with where it was written.
const marks = vueFiles(SRC).flatMap((path) => {
    const source = readFileSync(path, `utf8`);
    return [...source.matchAll(/(:|v-bind:)?data-setting(?:="([^"]*)")?/gu)].map((match) => ({
        file: relative(SRC, path),
        bound: match[1] !== undefined,
        id: match[2],
    }));
});

const sandbox = SANDBOX_CARDS;
const settings = SETTINGS_CARDS;
const entries: readonly SettingEntry[] = [...sandbox, ...settings];

describe(`the index and the cards`, () => {
    it(`names every card with an id of plain lower-case words, used once across both hubs`, () => {
        const ids = entries.map((entry) => entry.id);
        expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(id))).toEqual([]);
        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    });

    it(`writes every mark as a plain attribute, so this test can read it`, () => {
        expect(marks.filter((mark) => mark.bound || mark.id === undefined)).toEqual([]);
    });

    it(`marks every card the index lists, once, and lists every card that is marked`, () => {
        const marked = marks.map((mark) => mark.id);
        const listed = entries.map((entry) => entry.id);
        expect(listed.filter((id) => marked.filter((mark) => mark === id).length !== 1)).toEqual([]);
        expect(marked.filter((id) => id === undefined || !listed.includes(id))).toEqual([]);
    });

    it(`keeps each hub's marks in that hub's own pages`, () => {
        const fileOf = (id: string): string => marks.find((mark) => mark.id === id)?.file ?? ``;
        expect(sandbox.map((entry) => entry.id).filter((id) => !fileOf(id).startsWith(`features/sandbox/`))).toEqual([]);
        expect(settings.map((entry) => entry.id).filter((id) => !/^features\/(settings|organisations)\//u.test(fileOf(id)))).toEqual([]);
    });

    it(`puts every card on a page its hub has`, () => {
        const sandboxSlugs = sandboxBuiltInSlugs();
        const settingsSlugs = new Set<string>(settingsSections(true, false, false).map((section) => section.slug));
        expect(sandbox.filter((entry) => !sandboxSlugs.has(entry.slug)).map((entry) => entry.id)).toEqual([]);
        expect(settings.filter((entry) => !settingsSlugs.has(entry.slug)).map((entry) => entry.id)).toEqual([]);
        expect(Object.keys(sandboxPageTerms()).filter((slug) => !sandboxSlugs.has(slug))).toEqual([]);
        const settingsPageSlugs = new Set(settingsPages(settingsSections(true, false, false)).map((page) => page.slug));
        expect(Object.keys(settingsPageTerms()).filter((slug) => !settingsPageSlugs.has(slug))).toEqual([]);
    });

    // A category is read off the page's own address by the page itself, so an answer naming one the page does not know
    // lands on its default category, where the card is not.
    it(`names only categories the page reads, under the key it reads them from`, () => {
        const reads = new Map([
            [`agent`, { file: `features/sandbox/overview/SandboxAgent.vue`, key: `section` }],
            [`access`, { file: `features/sandbox/access/SandboxAccess.vue`, key: `section` }],
            [`data-protection`, { file: `features/sandbox/data-protection/SandboxDataProtection.vue`, key: `step` }],
        ]);
        const wrong = entries.flatMap((entry) => {
            if (entry.part === undefined) {
                return [];
            }
            const page = reads.get(entry.slug);
            if (page === undefined) {
                return [`${entry.id}: add ${entry.slug}'s page to this test`];
            }
            const source = readFileSync(join(SRC, page.file), `utf8`);
            const key = entry.partKey ?? `section`;
            return key === page.key && source.includes(`\`${entry.part}\``) && source.includes(`query[\`${key}\`]`)
                ? []
                : [`${entry.id}: ${key}=${entry.part}`];
        });
        expect(wrong).toEqual([]);
    });
});

describe(`addresses`, () => {
    it(`reads back the card an address names, and nothing from any other fragment`, () => {
        expect(settingOfHash(settingHash(`theme`))).toBe(`theme`);
        expect(settingOfHash(`#linked-sandboxes`)).toBeUndefined();
        expect(settingOfHash(`#setting-`)).toBeUndefined();
        expect(settingOfHash(``)).toBeUndefined();
    });
});

// The real tables, as a maintainer who writes code reads them in a browser tab on a desktop.
const MAINTAINER: HubReader = { maker: false, phone: false, app: false, canShip: true };

const sources = (canShip = true): readonly HubSource[] => [
    {
        hub: `sandbox`,
        pages: sandboxSections(canShip).map(({ slug, label, icon }) => ({ slug, label, icon })),
        entries: sandbox,
        pageTerms: sandboxPageTerms(),
    },
    {
        hub: `settings`,
        pages: settingsPages(settingsSections(true, false, false)),
        entries: settings,
        pageTerms: settingsPageTerms(),
    },
];

const ask = (query: string, reader = MAINTAINER, canShip = reader.canShip) => searchHubs(sources(canShip), reader, query);
const first = (query: string, reader?: HubReader): string | undefined => {
    const [best] = ask(query, reader);
    return best === undefined ? undefined : (best.setting ?? `page:${best.slug}`);
};

describe(`what people type`, () => {
    it(`finds a setting by its own name, and lands on its card`, () => {
        const [theme] = ask(`theme`);
        expect(theme?.setting).toBe(`theme`);
        expect(theme?.to).toEqual({ path: `/settings/appearance`, query: {}, hash: `#setting-theme` });
        expect(theme?.trail).toBe(`Appearance`);
    });

    it(`finds a setting by the words people use for it rather than ours`, () => {
        expect(first(`dark mode`)).toBe(`theme`);
        expect(ask(`api key`).map((result) => result.setting ?? `page:${result.slug}`)).toContain(`page:tokens`);
        expect(ask(`invoice`).map((result) => result.slug)).toContain(`billing`);
    });

    it(`opens a card behind its page's category, and says where it is`, () => {
        const voice = ask(`voice`).find((result) => result.setting === `agent-voice`);
        expect(voice?.to).toEqual({ path: `/sandbox/agent`, query: { section: `tools` }, hash: `#setting-agent-voice` });
        expect(voice?.trail).toBe(`Agent › Tools`);
        const documents = ask(`documents`).find((result) => result.setting === `data-protection-documents`);
        expect(documents?.to.query).toEqual({ step: `documents` });
    });

    // The one subject split between the hubs: the wake word this device listens for, and the agent's spoken replies.
    it(`answers from both hubs at once, the reader's own hub first`, () => {
        const found = ask(`voice`);
        expect(found.some((result) => result.hub === `settings` && result.setting === `wake-word`)).toBe(true);
        expect(found.some((result) => result.hub === `sandbox` && result.setting === `agent-voice`)).toBe(true);
        expect(groupByHub(found, `settings`).map((group) => group.hub)).toEqual([`settings`, `sandbox`]);
        expect(groupByHub(found, `sandbox`).map((group) => group.hub)).toEqual([`sandbox`, `settings`]);
    });

    // A word behind a title is not on screen, so it has to start one of those words: "voice" inside "invoice" is not a
    // reason to offer Billing to someone after the wake word.
    it(`matches the words behind a title only from their start`, () => {
        expect(ask(`voice`).map((result) => result.slug)).not.toContain(`billing`);
        expect(ask(`invoice`).map((result) => result.slug)).toContain(`billing`);
    });

    // Voice and Data are drawn at the foot of Notifications and Profile (settingsNav.ts `within`): the page by its old
    // address, which the router sends to its anchor there, and its cards on the section that draws them.
    it(`finds a page drawn inside another, and its cards on the section that draws them`, () => {
        const voice = ask(`voice`).find((result) => result.key === `settings:page:voice`);
        expect(voice?.to.path).toBe(`/settings/voice`);
        const wake = ask(`wake word`).find((result) => result.setting === `wake-word`);
        expect(wake?.to).toEqual({ path: `/settings/notifications`, query: {}, hash: `#setting-wake-word` });
        expect(ask(`delete account`).find((result) => result.setting === `delete-account`)?.to.path).toBe(`/settings/profile`);
    });

    it(`puts a page before a card of its own name`, () => {
        expect(first(`retention`)).toBe(`page:retention`);
    });

    it(`offers no card on a page this reader is not offered`, () => {
        const member: HubReader = { ...MAINTAINER, canShip: false };
        expect(ask(`voice`, member).some((result) => result.setting === `agent-voice`)).toBe(false);
        expect(ask(`voice`, member).some((result) => result.setting === `wake-word`)).toBe(true);
    });

    it(`offers no card its page leaves out for this reader`, () => {
        const maker: HubReader = { ...MAINTAINER, maker: true };
        expect(ask(`file tree`).some((result) => result.setting === `file-tree`)).toBe(true);
        expect(ask(`file tree`, maker).some((result) => result.setting === `file-tree`)).toBe(false);
        const phone: HubReader = { ...MAINTAINER, phone: true };
        expect(ask(`icon rail`, phone).some((result) => result.setting === `icon-rail`)).toBe(false);
    });

    it(`names the card by what the page calls it for this reader`, () => {
        const tab = ask(`badge`).find((result) => result.setting === `status-badge`);
        const app = ask(`badge`, { ...MAINTAINER, app: true }).find((result) => result.setting === `status-badge`);
        expect(tab?.title).toBe(`Browser tab`);
        expect(app?.title).toBe(`Taskbar and tray`);
    });

    it(`answers nothing to nothing typed`, () => {
        expect(ask(`   `)).toEqual([]);
    });

    it(`names the default page outright, which a phone's param-less address would not show`, () => {
        expect(ask(`display name`)[0]?.to.path).toBe(`/settings/${SETTINGS_DEFAULT_SECTION}`);
    });
});
