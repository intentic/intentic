import "@intentic/testing/dom";
import { setLocale, useT } from "@intentic/ui/i18n";
import en from "../../app/i18n/locales/en.json";
import { vocabularyFor } from "./vocabulary";

// THE PLAIN WORDS STAY PLAIN. A reader who answered "I don't write code" (and a guest) is shown the maker's column of
// the vocabulary table and every message kept under a `plain` key; none of it may say a word only a developer knows.
// The list below is the one place those words are named: add a word here and every plain string is held to it.

interface DeveloperWord {
    readonly word: string;
    readonly pattern: RegExp;
}

// Whole words only, in any case, with Polish inflections spelled out: `\b` knows no letter past ASCII, so a word's edges
// are "not a letter" in Unicode's sense instead.
const whole = (stem: string): RegExp => new RegExp(`(?<!\\p{L})(?:${stem})(?!\\p{L})`, `iu`);

const DEVELOPER_WORDS: readonly DeveloperWord[] = [
    { word: `agent`, pattern: whole(`agent\\p{L}*`) },
    { word: `git`, pattern: whole(`git`) },
    { word: `branch`, pattern: whole(`branch\\p{L}*|gał[ąę]\\p{L}*`) },
    { word: `commit`, pattern: whole(`commit\\p{L}*`) },
    { word: `diff`, pattern: whole(`diffs?|diff(?:a|y|ie|em|ów)`) },
    { word: `merge`, pattern: whole(`merg\\p{L}*|scal\\p{L}*`) },
    { word: `worktree`, pattern: whole(`worktree\\p{L}*`) },
    { word: `repo`, pattern: whole(`repo\\p{L}*`) },
    { word: `token`, pattern: whole(`token\\p{L}*`) },
    { word: `MCP`, pattern: whole(`MCP`) },
    { word: `persona`, pattern: whole(`person(?:a|as|y|ę|ie|ą|om|ami)`) },
    { word: `workflow`, pattern: whole(`workflow\\p{L}*`) },
    { word: `sandbox`, pattern: whole(`sandbox\\p{L}*`) },
    { word: `Claude Code`, pattern: whole(`Claude Code`) },
    { word: `Codex`, pattern: whole(`Codex`) },
    { word: `turn`, pattern: whole(`turns?|tur(?:a|y|ę|ze|ą|ami)?`) },
    { word: `deploy`, pattern: whole(`deploy\\p{L}*|wdro[żz]\\p{L}*`) },
];

const developerWordsIn = (text: string): string[] => DEVELOPER_WORDS.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);

// Every key under a `plain` segment, read off English, which every other catalog is a subset of.
type Tree = { readonly [key: string]: string | Tree };
const plainKeys = (tree: Tree, path: readonly string[] = []): string[] =>
    Object.entries(tree).flatMap(([name, value]) => {
        const at = [...path, name];
        if (value instanceof Object) {
            return plainKeys(value, at);
        }
        return at.includes(`plain`) ? [at.join(`.`)] : [];
    });

// Words the plain screens borrow from the shared catalog rather than a `plain` key of their own: the posture names in the
// "How much it does on its own" menu, the Stop press, the rail's labels and the board's empty lanes.
const BORROWED = [
    `chat.catalog.auto`,
    `chat.catalog.manual`,
    `chat.catalog.plan`,
    `chat.catalog.askBeforeEachEdit`,
    `chat.catalog.proposePlanWaitApproval`,
    `chat.catalog.runEverythingWithoutAsking`,
    `ui.action.stop`,
    `shared.chat`,
    `shared.files`,
    `chat.words.newChat`,
    `chat.chatPane.startConversationAny`,
    `agents.agentsView.nothingNeedsRightNow`,
];

// A key read whole, wherever its catalog mounts (`ui.` is the kit's): the namespace is its first segment.
const say = (key: string): string => {
    const dot = key.indexOf(`.`);
    return useT(key.slice(0, dot))(key.slice(dot + 1));
};

const offences = (): string[] => {
    // The one row that is a message per count, read at a count that takes the plural; every other row is its words.
    const { pendingChanges, ...rows } = vocabularyFor(`maker`);
    const strings: [string, string][] = [
        ...Object.entries(rows).map(([key, value]): [string, string] => [`vocabulary.maker.${key}`, value]),
        [`vocabulary.maker.pendingChanges`, pendingChanges(2)],
        ...[...plainKeys(en), ...BORROWED].map((key): [string, string] => [key, say(key)]),
    ];
    return strings.flatMap(([key, text]) => developerWordsIn(text).map((word) => `${key}: "${word}" in "${text}"`));
};

afterAll(async () => {
    await setLocale(`en`);
});

describe(`plain words`, () => {
    it(`finds every plain key the catalog holds`, () => {
        expect(plainKeys(en).length).toBeGreaterThan(20);
    });

    it(`say no developer word in English`, async () => {
        await setLocale(`en`);
        expect(offences()).toEqual([]);
    });

    it(`say no developer word in Polish`, async () => {
        await setLocale(`pl`);
        expect(offences()).toEqual([]);
    });

    it(`would catch one, inflected or not`, () => {
        expect(developerWordsIn(`Zarchiwizuj agenta`)).toEqual([`agent`]);
        expect(developerWordsIn(`Zatrzymaj turę`)).toEqual([`turn`]);
        expect(developerWordsIn(`Usuń gałąź`)).toEqual([`branch`]);
        expect(developerWordsIn(`Zapytaj Claude Code…`)).toEqual([`Claude Code`]);
        expect(developerWordsIn(`Your personal return`)).toEqual([]);
    });
});
