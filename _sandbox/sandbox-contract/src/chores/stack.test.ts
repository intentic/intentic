import { describe, expect, test } from "vitest";
import { componentStem, frameworksOf, IDIOM_RULES, idiomRule, UI_FRAMEWORKS, usesTailwind } from "./stack.js";

/* The table's own invariants, and the name normaliser under it.
 *
 * Most of what is below guards a failure that CANNOT be seen by reading the table: a pattern is interpolated into
 * a shell command that runs on someone else's machine at three in the morning, so a stray quote is not a typo
 * anyone reviews: it is a probe that dies in a workspace nobody is watching, with a shell error for a reason. */

describe(`the patterns are safe to interpolate`, () => {
    // The scan wraps every pattern and glob in shell single quotes. One apostrophe inside ends the quoting and
    // hands the remainder of the regex to sh, which is how a pattern becomes a command.
    test(`no pattern or glob contains an apostrophe`, () => {
        for (const rule of IDIOM_RULES) {
            expect(rule.pattern, rule.id).not.toContain(`'`);
            for (const glob of rule.globs) {
                expect(glob, rule.id).not.toContain(`'`);
            }
        }
    });

    // Not the dialect ripgrep will use, but it catches the unbalanced bracket and the stray backslash, which is
    // what actually goes wrong when someone adds a rule.
    test(`every pattern parses as a regex`, () => {
        for (const rule of IDIOM_RULES) {
            expect(() => new RegExp(rule.pattern), rule.id).not.toThrow();
        }
    });

    /* Rust's regex crate has no lookaround, and getting it means ripgrep's -P, which is a compile-time option on
     * the box the sweep happens to run on. A rule that seems to need one is asking a question about the FILE
     * rather than about a line, which is what `absent` is. */
    test(`no pattern uses a lookaround`, () => {
        for (const rule of IDIOM_RULES) {
            expect(rule.pattern, rule.id).not.toMatch(/\(\?<?[=!]/);
        }
    });

    /* An absent rule's population is every file its globs match, so a glob that is merely broad on a normal rule
     * is catastrophic on this one: `*.ts` would name every TypeScript file in the repository as legacy code. A
     * component extension is safe because every file wearing it is the thing the migration is about. */
    test(`an absent rule is scoped to a component file type, never to a whole language`, () => {
        for (const rule of IDIOM_RULES.filter((candidate) => candidate.absent !== undefined)) {
            for (const glob of rule.globs) {
                expect([`*.ts`, `*.js`, `*.mts`, `*.cts`, `*.mjs`, `*.cjs`], rule.id).not.toContain(glob);
            }
        }
    });

    test(`every rule has a unique id and belongs to a framework in the table`, () => {
        const ids = new Set(IDIOM_RULES.map((rule) => rule.id));
        expect(ids.size).toBe(IDIOM_RULES.length);
        for (const rule of IDIOM_RULES) {
            expect(
                UI_FRAMEWORKS.map((framework) => framework.id),
                rule.id,
            ).toContain(rule.framework);
        }
    });

    // The chore names the replacement in its prompt; a rule without one would wake an agent, tell it what to stop
    // doing and leave it to guess a destination.
    test(`every rule names what replaced it`, () => {
        for (const rule of IDIOM_RULES) {
            expect(rule.replacement.length, rule.id).toBeGreaterThan(3);
        }
    });

    test(`idiomRule finds a rule the scan reports, and admits when it cannot`, () => {
        expect(idiomRule(`vue-options-api`)?.framework).toBe(`vue`);
        expect(idiomRule(`from-a-newer-daemon`)).toBeUndefined();
    });
});

describe(`recognising the stack`, () => {
    test(`a framework is recognised from any manifest's dependency names`, () => {
        expect(frameworksOf([`vue`, `vite`]).map((framework) => framework.id)).toEqual([`vue`]);
        expect(frameworksOf([`react`, `@angular/core`]).map((framework) => framework.id)).toEqual([`react`, `angular`]);
        expect(frameworksOf([`pino`, `zod`])).toEqual([]);
    });

    // A near-miss must not read as a hit: plenty of packages are named after the framework they plug into, and
    // `@vueuse/core` in a repo with no Vue is a dependency somebody left behind rather than a Vue application.
    test(`a package merely named after a framework is not that framework`, () => {
        expect(frameworksOf([`@vueuse/core`, `react-hook-form`, `eslint-plugin-vue`])).toEqual([]);
    });

    test(`Tailwind is recognised on its own, without a framework`, () => {
        expect(usesTailwind([`tailwindcss`])).toBe(true);
        expect(usesTailwind([`@tailwindcss/typography`])).toBe(false);
    });
});

/* THE NORMALISER, which is the whole evidence of the component-overlap chore and therefore the place a false
 * finding would come from. Each case below is a family that must form, or one that must not. */
describe(`the name two components share`, () => {
    test(`framework and qualifier noise falls away`, () => {
        expect(componentStem(`src/components/Button.vue`)).toBe(`button`);
        expect(componentStem(`src/ui/BaseButton.vue`)).toBe(`button`);
        expect(componentStem(`src/legacy/ButtonV2.tsx`)).toBe(`button`);
        expect(componentStem(`src/app/user-card.component.ts`)).toBe(`usercard`);
        expect(componentStem(`src/UserCard.tsx`)).toBe(`usercard`);
    });

    // Every barrel file in the repository is called this. A family of forty is a fact about the convention, not
    // about duplication, and it would be the largest finding in every repo that has one.
    test(`index files never form a family`, () => {
        expect(componentStem(`src/components/Button/index.tsx`)).toBeUndefined();
    });

    /* The trap in stripping a trailing number. `H1` and `H2` are different components and reduce to the same
     * single letter, so the stem is only accepted when what survives is still long enough to mean something:
     * otherwise the untouched name is kept and the two stay apart. */
    test(`short names keep their digits rather than collapsing together`, () => {
        expect(componentStem(`src/type/H1.tsx`)).toBe(`h1`);
        expect(componentStem(`src/type/H2.tsx`)).toBe(`h2`);
        expect(componentStem(`src/type/H1.tsx`)).not.toBe(componentStem(`src/type/H2.tsx`));
    });

    // Same guard on the prefix side: `Theme` begins with `the`, and stripping it would leave `me` and put Theme
    // in a family with anything else that reduced to it.
    test(`a word that merely starts with a qualifier is left alone`, () => {
        expect(componentStem(`src/Theme.tsx`)).toBe(`theme`);
        expect(componentStem(`src/TheHeader.vue`)).toBe(`header`);
    });
});
