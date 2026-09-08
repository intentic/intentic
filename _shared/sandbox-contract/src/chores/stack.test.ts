import { describe, expect, test } from "vitest";
import { componentStem, frameworksOf, IDIOM_RULES, idiomRule, UI_FRAMEWORKS, usesTailwind } from "./stack.js";

// Guards shell-safety of interpolated patterns (checked unattended on a remote machine) and the stem normalizer below
// the table.

describe(`the patterns are safe to interpolate`, () => {
    test(`no pattern or glob contains an apostrophe`, () => {
        for (const rule of IDIOM_RULES) {
            expect(rule.pattern, rule.id).not.toContain(`'`);
            for (const glob of rule.globs) {
                expect(glob, rule.id).not.toContain(`'`);
            }
        }
    });

    test(`every pattern parses as a regex`, () => {
        for (const rule of IDIOM_RULES) {
            expect(() => new RegExp(rule.pattern), rule.id).not.toThrow();
        }
    });

    test(`no pattern uses a lookaround`, () => {
        for (const rule of IDIOM_RULES) {
            expect(rule.pattern, rule.id).not.toMatch(/\(\?<?[=!]/);
        }
    });

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

// Only rule names built from ordinary words are tested against real lines; `@NgModule(` and `ReactDOM.render(` can't be
// mistaken for anything else.
describe(`the Vue 2 teardown hooks`, () => {
    const hits = (line: string): boolean => new RegExp(idiomRule(`vue-2-lifecycle`)?.pattern ?? `(?:)`).test(line);

    test(`a hook is found however the component writes it`, () => {
        expect(hits(`    destroyed() {`)).toBe(true);
        expect(hits(`    beforeDestroy() {`)).toBe(true);
        expect(hits(`    destroyed: function () {`)).toBe(true);
        expect(hits(`    destroyed: async () => {`)).toBe(true);
        expect(hits(`    beforeDestroy: this.teardown,`)).toBe(true);
    });

    test(`a field named after the word is not a hook`, () => {
        expect(hits(`): Promise<{ warned: number; destroyed: number; dropped: number }> => {`)).toBe(false);
        expect(hits(`    const tally = { warned: 0, destroyed: 0, dropped: 0 };`)).toBe(false);
        expect(hits(`    return \`destroyed\`;`)).toBe(false);
        expect(hits(`    if (machine.destroyed) {`)).toBe(false);
        expect(hits(`type IdleVerdict = "kept" | "warned" | "destroyed" | "dropped";`)).toBe(false);
    });

    test(`the sweep asks the question of components only`, () => {
        expect(idiomRule(`vue-2-lifecycle`)?.globs).toEqual([`*.vue`]);
    });
});

describe(`recognising the stack`, () => {
    test(`a framework is recognised from any manifest's dependency names`, () => {
        expect(frameworksOf([`vue`, `vite`]).map((framework) => framework.id)).toEqual([`vue`]);
        expect(frameworksOf([`react`, `@angular/core`]).map((framework) => framework.id)).toEqual([`react`, `angular`]);
        expect(frameworksOf([`pino`, `zod`])).toEqual([]);
    });

    test(`a package merely named after a framework is not that framework`, () => {
        expect(frameworksOf([`@vueuse/core`, `react-hook-form`, `eslint-plugin-vue`])).toEqual([]);
    });

    test(`Tailwind is recognised on its own, without a framework`, () => {
        expect(usesTailwind([`tailwindcss`])).toBe(true);
        expect(usesTailwind([`@tailwindcss/typography`])).toBe(false);
    });
});

// The stem normalizer is the component-overlap chore's only evidence; each case is a family that must form, or must
// not.
describe(`the name two components share`, () => {
    test(`framework and qualifier noise falls away`, () => {
        expect(componentStem(`src/components/Button.vue`)).toBe(`button`);
        expect(componentStem(`src/ui/BaseButton.vue`)).toBe(`button`);
        expect(componentStem(`src/legacy/ButtonV2.tsx`)).toBe(`button`);
        expect(componentStem(`src/app/user-card.component.ts`)).toBe(`usercard`);
        expect(componentStem(`src/UserCard.tsx`)).toBe(`usercard`);
    });

    test(`index files never form a family`, () => {
        expect(componentStem(`src/components/Button/index.tsx`)).toBeUndefined();
    });

    test(`framework entry names never form a family`, () => {
        expect(componentStem(`apps/web/src/App.vue`)).toBeUndefined();
        expect(componentStem(`apps/desktop/src/App.vue`)).toBeUndefined();
        expect(componentStem(`app/dashboard/page.tsx`)).toBeUndefined();
        expect(componentStem(`app/settings/layout.tsx`)).toBeUndefined();
        expect(componentStem(`app/settings/not-found.tsx`)).toBeUndefined();
    });

    test(`a component that only starts with a framework name is kept`, () => {
        expect(componentStem(`src/shell/AppShell.vue`)).toBe(`appshell`);
        expect(componentStem(`src/ErrorBoundary.tsx`)).toBe(`errorboundary`);
        expect(componentStem(`src/PageHeader.vue`)).toBe(`pageheader`);
    });

    test(`short names keep their digits rather than collapsing together`, () => {
        expect(componentStem(`src/type/H1.tsx`)).toBe(`h1`);
        expect(componentStem(`src/type/H2.tsx`)).toBe(`h2`);
        expect(componentStem(`src/type/H1.tsx`)).not.toBe(componentStem(`src/type/H2.tsx`));
    });

    test(`a word that merely starts with a qualifier is left alone`, () => {
        expect(componentStem(`src/Theme.tsx`)).toBe(`theme`);
        expect(componentStem(`src/TheHeader.vue`)).toBe(`header`);
    });
});
