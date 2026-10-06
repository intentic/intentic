import {
    type Catalog,
    type CatalogEntry,
    catalogHome,
    dynamicKeyPattern,
    entryMatch,
    isCatalogPath,
    keyUsePattern,
    localeOf,
    matchCatalogs,
    matchEntry,
    normalizeText,
    parseCatalog,
} from "./catalog.js";

const CATALOG = `{
    "agents": {
        "accountChip": {
            "org": "Organization"
        },
        "agentActions": {
            "noConversationLeft": "That agent has no conversation left to send to.",
            "quoted": "Say \\"hi\\" \\u00e9",
            "steps": ["first step", "second step"]
        }
    },
    "count": 3,
    "updates": {
        "keptFailing": "{to} kept failing, so this machine went back to {from} by itself.",
        "entries": "{count} entry | {count} entries"
    }
}
`;

describe("parseCatalog", () => {
    const entries = parseCatalog(CATALOG);
    const byKey = (key: string): CatalogEntry | undefined => entries.find((entry) => entry.key === key);

    test("resolves each string to its full dotted key and the line it sits on", () => {
        expect(byKey("agents.agentActions.noConversationLeft")).toEqual({
            key: "agents.agentActions.noConversationLeft",
            line: 7,
            value: "That agent has no conversation left to send to.",
        });
        expect(byKey("agents.accountChip.org")?.line).toBe(4);
        expect(byKey("updates.keptFailing")?.line).toBe(14);
    });

    test("decodes escapes, indexes arrays, and skips what is not text", () => {
        expect(byKey("agents.agentActions.quoted")?.value).toBe('Say "hi" é');
        expect(byKey("agents.agentActions.steps.1")?.value).toBe("second step");
        expect(byKey("count")).toBeUndefined();
    });

    test("malformed input keeps what was read before the fault", () => {
        const partial = parseCatalog(`{\n  "a": { "b": "kept" },\n  "c": oops\n`);
        expect(partial.map((entry) => entry.key)).toEqual(["a.b"]);
    });
});

describe("which files are catalogs", () => {
    test("a JSON file under a catalog directory, its locale from its name or its folder", () => {
        expect(isCatalogPath("_editor/web/src/app/i18n/locales/en.json")).toBe(true);
        expect(isCatalogPath("public/locales/en-US/translation.json")).toBe(true);
        expect(isCatalogPath("package.json")).toBe(false);
        expect(isCatalogPath("src/locales/en.ts")).toBe(false);
        expect(localeOf("_editor/web/src/app/i18n/locales/pl.json")).toBe("pl");
        expect(localeOf("public/locales/en-US/translation.json")).toBe("en-US");
    });

    test("a catalog serves the source tree it sits in", () => {
        expect(catalogHome("_editor/web/src/app/i18n/locales/en.json")).toBe("_editor/web/src/");
        expect(catalogHome("_extensions/activity/src/locales/en.json")).toBe("_extensions/activity/src/");
        expect(catalogHome("public/locales/en-US/translation.json")).toBe("public/");
    });
});

describe("matching UI text to an entry", () => {
    const entries = parseCatalog(CATALOG);
    const entry = (key: string): CatalogEntry => entries.find((candidate) => candidate.key === key)!;
    const match = (key: string, text: string, wholeOnly = false): number | undefined => matchEntry(entry(key), normalizeText(text), { wholeOnly });

    test("the whole string matches regardless of case, punctuation and an ellipsis typed as dots", () => {
        expect(match("agents.agentActions.noConversationLeft", "that agent has NO conversation left to send to")).toBe(1);
        expect(match("agents.agentActions.noConversationLeft", "That agent has no conversation left to send to...")).toBe(1);
    });

    test("a screenshot's filled-in slots match the template", () => {
        expect(match("updates.keptFailing", "1.4.2 kept failing, so this machine went back to 1.4.1 by itself.")).toBe(1);
        expect(match("updates.keptFailing", "Kubernetes kept failing, so this machine went back to the last good version by itself")).toBe(1);
    });

    // Replayed 2026-10-06 against mined queries: "background job indicator in chat" matched "{count} chat", and
    // "pipelines view running state list" matched "{running} · {elapsed}".
    test("a template with too few words of its own vouches for nothing", () => {
        expect(match("updates.entries", "12 entries")).toBeUndefined();
        const sparse: CatalogEntry[] = [
            { key: "chats", line: 1, value: "{count} chat | {count} chats" },
            { key: "running", line: 2, value: "{running} · {elapsed}" },
        ];
        expect(matchEntry(sparse[0]!, normalizeText("background job indicator in chat"))).toBeUndefined();
        expect(matchEntry(sparse[1]!, normalizeText("pipelines view running state list"))).toBeUndefined();
    });

    test("part of a string matches below a whole one, on word boundaries only", () => {
        const partial = match("agents.agentActions.noConversationLeft", "no conversation left to send");
        expect(partial).toBeGreaterThan(0.5);
        expect(partial).toBeLessThan(1);
        expect(match("agents.agentActions.noConversationLeft", "o conversation left to sen")).toBeUndefined();
    });

    test("two words match only as the whole string", () => {
        expect(match("agents.accountChip.org", "organization")).toBe(1);
        expect(match("agents.agentActions.noConversationLeft", "conversation left")).toBeUndefined();
    });

    test("a question matches only a whole string, not a part that reads like one", () => {
        expect(match("agents.agentActions.noConversationLeft", "has no conversation left to send to", true)).toBeUndefined();
        expect(match("agents.agentActions.noConversationLeft", "That agent has no conversation left to send to.", true)).toBe(1);
    });

    test("a run of the string is verbatim; the string inside a longer query is a match but not a quote", () => {
        const label: CatalogEntry = { key: "personas.match", line: 1, value: "Match new chats to a persona" };
        expect(entryMatch(label, normalizeText("match new chats to a"))).toMatchObject({ verbatim: true });
        expect(entryMatch(label, normalizeText("Match new chats to a persona automatically"))).toMatchObject({ verbatim: false });
        // A label covering under three quarters of the query is a description that mentions it.
        expect(entryMatch(label, normalizeText("match new chats to a persona automatic persona matching"))).toBeUndefined();
    });

    test("a label inside a longer question is not a match: the query must be mostly the string", () => {
        const label: CatalogEntry = { key: "connect.title", line: 1, value: "Connect a model" };
        expect(matchEntry(label, normalizeText("how do I connect a model to the agent in settings"))).toBeUndefined();
        expect(matchEntry(label, normalizeText("Connect a model now please"))).toBeUndefined();
        expect(matchEntry(label, normalizeText("Connect a model now"))).toBeGreaterThan(0.5);
    });
});

describe("matchCatalogs", () => {
    const catalog = (path: string, locale: string, value: string): Catalog => ({ path, locale, entries: [{ key: "a.b", line: 2, value }] });

    test("English first among equal matches: an untranslated string sits in every locale", () => {
        const matches = matchCatalogs(
            [catalog("i18n/locales/pl.json", "pl", "Nothing to land here"), catalog("i18n/locales/en.json", "en", "Nothing to land here")],
            "nothing to land here",
        );
        expect(matches.map((found) => found.catalog.locale)).toEqual(["en", "pl"]);
    });
});

describe("key patterns", () => {
    test("a key in code is a quoted key, in any quote", () => {
        const pattern = new RegExp(keyUsePattern(["agents.agentActions.noConversationLeft"]));
        expect(pattern.test("t(`agents.agentActions.noConversationLeft`)")).toBe(true);
        expect(pattern.test(`$t("agents.agentActions.noConversationLeft")`)).toBe(true);
        expect(pattern.test("// agents.agentActions.noConversationLeft")).toBe(false);
        expect(pattern.test("t(`agentsXagentActions.noConversationLeft`)")).toBe(false);
    });

    test("a dynamic key is found by the template its parent is built in", () => {
        const pattern = new RegExp(dynamicKeyPattern("agents.agentActions.noConversationLeft")!);
        expect(pattern.test("t(`agents.agentActions.${reason}`)")).toBe(true);
        expect(dynamicKeyPattern("top")).toBeUndefined();
    });
});
