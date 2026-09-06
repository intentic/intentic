/* WHAT THIS REPOSITORY IS BUILT WITH, and the patterns that follow from it, the table the UI chores are written
 * against, kept apart from both the probe that runs it and the chores that read it.
 *
 * It sits in the middle on purpose. probes.ts composes ONE ripgrep sweep out of the rules below, and chores.ts
 * turns the counts that come back into findings and prose. Put the rules in either of those and the other one
 * grows a copy: the probe would hard-code patterns the chore has to describe in words, or the chore would restate
 * globs the probe already walked. Both copies would then be free to disagree about what a component is.
 *
 * NOTHING HERE IS A VERDICT. A framework is a set of dependency names, an idiom is a regex and the name of what
 * replaced it. Which of those amount to work worth doing is the chore book's judgement, made in chores.ts against
 * the same three rules everything else there obeys.
 *
 * THE PATTERNS ARE RIPGREP'S DIALECT, and they carry two constraints that are not obvious from reading them:
 *
 *   No literal apostrophe, ever. The scan command wraps each pattern in shell single quotes, so a `'` inside one
 *   would end the quoting and hand the rest of the regex to the shell. Match quotes as `[\x22\x27]` instead,
 *   Rust's regex crate reads those escapes, and the shell never sees a quote character at all. stack.test.ts
 *   enforces this, because the failure is a probe that dies at three in the morning in someone else's workspace
 *   rather than anything a reader would notice here.
 *
 *   No lookaround. Rust's regex crate has none, and reaching for ripgrep's PCRE2 mode to get it would make the
 *   sweep depend on how the box's ripgrep was compiled. A rule that seems to need it is usually asking a question
 *   about the FILE rather than about a line, see `absent` below, which is what that question actually is. */

export interface UiFramework {
    readonly id: string;
    readonly label: string;
    // The dependency names that mean "this repository is built with it". Any one of them is enough.
    readonly packages: readonly string[];
}

/* The three the maintenance surface knows how to say something specific about. Deliberately not "every framework
 * with a npm package": a framework earns a row here by having idiom rules underneath it, and a table entry with
 * no rules would let a chore announce it recognised Svelte and then have nothing to report. */
export const UI_FRAMEWORKS: readonly UiFramework[] = [
    { id: `react`, label: `React`, packages: [`react`] },
    { id: `vue`, label: `Vue`, packages: [`vue`] },
    { id: `angular`, label: `Angular`, packages: [`@angular/core`] },
];

// Tailwind is not in the table above because it is not a UI framework and does not own any idiom rules, it is a
// styling system that any of the three can be wearing, and it gates exactly one chore.
export const TAILWIND_PACKAGES: readonly string[] = [`tailwindcss`];

export const frameworksOf = (deps: readonly string[]): UiFramework[] =>
    UI_FRAMEWORKS.filter((framework) => framework.packages.some((name) => deps.includes(name)));

export const usesTailwind = (deps: readonly string[]): boolean => TAILWIND_PACKAGES.some((name) => deps.includes(name));

/* Directories a UI scan must never walk, spelled out rather than left to the repository's .gitignore. ripgrep
 * does honour .gitignore, and relying on that is how a repo whose build output is not ignored gets its own
 * minified bundle reported back to it as a thousand hard-coded colours. Tests, specs and stories are excluded for
 * a different reason: they are component-shaped files that are not components, and counting them would put a
 * fixture at the top of every finding. */
export const SCAN_IGNORES: readonly string[] = [
    `!**/node_modules/**`,
    `!**/dist/**`,
    `!**/build/**`,
    `!**/.next/**`,
    `!**/out/**`,
    `!**/coverage/**`,
    `!**/vendor/**`,
    `!**/generated/**`,
    `!**/*.{test,spec,stories}.*`,
];

// What counts as a component file, across all three frameworks at once. The sweep cannot vary by repository, a
// probe's command is a fixed string, so it asks for all of them and a Vue-only repo simply has no `.tsx` files.
export const COMPONENT_GLOBS: readonly string[] = [`*.vue`, `*.tsx`, `*.jsx`, `*.component.ts`];

// Where a Tailwind class can appear. Wider than COMPONENT_GLOBS because a class list lives in markup as often as
// in a component, an Angular template and a plain .html page both style with the same utilities.
export const MARKUP_GLOBS: readonly string[] = [`*.vue`, `*.tsx`, `*.jsx`, `*.html`, `*.svelte`, `*.astro`];

/* THE DESIGN SYSTEM BYPASS. Not "any arbitrary value", `grid-cols-[1fr_auto]` and `w-[calc(100%-2rem)]` are
 * Tailwind working as designed, and a chore that counted them would be objecting to the feature rather than to
 * anything wrong. What this matches is the two arbitrary values that route around a decision the theme already
 * made: a colour that is not in the palette, and a pixel size that is not on the spacing or type scale.
 *
 * The leading `-` is required. It anchors the match to a utility prefix (`bg-`, `text-`, `w-`), so a bare
 * `[...]` in ordinary prose or an array index cannot be mistaken for a class. */
export const BYPASS_PATTERN = `-\\[(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\\(|[0-9]+(\\.[0-9]+)?px)`;

export interface IdiomRule {
    readonly id: string;
    // Which framework's migration this belongs to, so a finding can be grouped under the thing that moved on.
    readonly framework: string;
    // What the repository still has, named as the reader would name it.
    readonly label: string;
    // What replaced it. Carried so the prompt can say where to go rather than only what to leave, an agent told
    // "you still use NgModule" and nothing else will pick a destination, and it may not pick this one.
    readonly replacement: string;
    readonly pattern: string;
    readonly globs: readonly string[];
    /* THE IDIOM IS THE PATTERN BEING MISSING, not present, `pattern` names the NEW way, and the file is on the
     * old one precisely because the new one does not appear in it anywhere. The sweep spells this
     * `--files-without-match`.
     *
     * This exists because the alternative got it wrong in a way that is worth remembering. "A Vue file not using
     * <script setup>" was first written as a lookahead over `<script`, which matches per LINE: a migrated
     * component with a second plain `<script>` block for defineOptions, or one that merely mentions `<script` in
     * a comment, both read as un-migrated. It reported five files in an application whose 167 SFCs are every one
     * of them migrated. The question was never "is there a line like this", it is "does this file contain the
     * new idiom at all", which is one flag rather than a cleverer regex, and it costs no PCRE2.
     *
     * The globs carry more weight on an absent rule than on a normal one, and narrowly is the only safe way to
     * write them: the population is every file they match, so `*.ts` on an absent rule reports the entire
     * repository. Keep them to the file type the migration is actually about. */
    readonly absent?: true;
}

/* THE IDIOMS THEIR OWN MAINTAINERS HAVE MOVED ON FROM. Every rule here names something the framework's own
 * documentation now steers people away from, and every one of them still works, which is exactly why they
 * accumulate, and why no editor and no linter will bring them up unprompted.
 *
 * High confidence over coverage. Each pattern is one a reader can check by eye against a file, and the ones that
 * would need real parsing to get right are left out rather than approximated: a rule that is wrong a third of the
 * time trains people to stop reading the row it appears in. */
export const IDIOM_RULES: readonly IdiomRule[] = [
    {
        id: `react-class-component`,
        framework: `react`,
        label: `class components`,
        replacement: `function components with hooks`,
        pattern: `extends\\s+(React\\.)?(Pure)?Component\\b`,
        globs: [`*.tsx`, `*.jsx`],
    },
    {
        id: `react-legacy-render`,
        framework: `react`,
        label: `the legacy ReactDOM.render entry point`,
        replacement: `createRoot from react-dom/client`,
        pattern: `ReactDOM\\.render\\(`,
        globs: [`*.tsx`, `*.jsx`, `*.ts`, `*.js`],
    },
    {
        id: `react-unsafe-lifecycle`,
        framework: `react`,
        // Named as what they are rather than by the UNSAFE_ prefix: a reader who has never renamed one would not
        // recognise "UNSAFE_componentWillMount" as describing their own file.
        label: `the pre-16.3 lifecycle methods`,
        replacement: `effects, or the UNSAFE_ prefixed names if the behaviour is genuinely wanted`,
        pattern: `\\bcomponentWill(Mount|ReceiveProps|Update)\\b`,
        globs: [`*.tsx`, `*.jsx`],
    },
    {
        id: `react-prop-types`,
        framework: `react`,
        label: `runtime prop-types`,
        replacement: `the component's own TypeScript props type`,
        pattern: `from\\s+[\\x22\\x27]prop-types[\\x22\\x27]`,
        globs: [`*.tsx`, `*.jsx`],
    },
    {
        id: `vue-options-api`,
        framework: `vue`,
        label: `the Options API`,
        replacement: `<script setup> with the Composition API`,
        // The new idiom, inverted by `absent` below, an SFC that never opens a `<script setup>` tag is still on
        // the old one. A file with no script block at all is swept up too, and that is the honest reading: it has
        // not been migrated because there was nothing there to migrate.
        pattern: `<script[^>]*\\bsetup\\b`,
        globs: [`*.vue`],
        absent: true,
    },
    {
        id: `vue-2-lifecycle`,
        framework: `vue`,
        label: `the Vue 2 teardown hooks`,
        replacement: `beforeUnmount and unmounted`,
        /* TWO NAMES, AND ONLY ONE OF THEM IS VUE'S. `beforeDestroy` is a word nobody writes by accident, so its
         * presence is the finding. `destroyed` is ordinary English, and asking only for a `(` or a `:` after it
         * matched `{ warned: number; destroyed: number }` in a backend module that reaps idle machines: the chore
         * told its reader to migrate a Node file to beforeUnmount, which is the kind of row that teaches people to
         * stop reading the rest. So the ambiguous half has to be a FUNCTION in an options object, the only shape a
         * hook is ever written in, and a field or a type named after the word is no longer evidence of anything.
         *
         * The globs are the second half of the same guard, and `*.ts` was the reason a backend file was eligible at
         * all. A teardown hook is a component's, so this reads components. What that gives up is a Vue 2 mixin
         * living in a plain `.js` file, and it is the right trade: `vue-global-api` still catches such a file when
         * it constructs anything, and an idiom found nowhere costs less than one found in the wrong repository. */
        pattern: `\\bbeforeDestroy\\s*[(:]|\\bdestroyed\\s*(\\(\\s*\\)\\s*\\{|:\\s*(async\\s+)?(function|\\(\\s*\\)\\s*=>))`,
        globs: [`*.vue`],
    },
    {
        id: `vue-global-api`,
        framework: `vue`,
        label: `the Vue 2 global constructor`,
        replacement: `createApp and defineComponent`,
        pattern: `\\b(new\\s+Vue\\(|Vue\\.extend\\()`,
        globs: [`*.vue`, `*.ts`, `*.js`],
    },
    {
        id: `angular-ngmodule`,
        framework: `angular`,
        label: `NgModule declarations`,
        replacement: `standalone components`,
        pattern: `@NgModule\\(`,
        globs: [`*.ts`],
    },
    {
        id: `angular-structural-directives`,
        framework: `angular`,
        label: `the structural directives`,
        replacement: `the built-in control flow blocks`,
        pattern: `\\*ng(If|For|Switch)\\b`,
        globs: [`*.html`, `*.ts`],
    },
    {
        id: `angular-module-providers`,
        framework: `angular`,
        label: `the module-based providers`,
        replacement: `the provide* functions in the application config`,
        pattern: `\\b(HttpClientModule|BrowserAnimationsModule|RouterModule\\.forRoot)\\b`,
        globs: [`*.ts`],
    },
];

export const idiomRule = (id: string): IdiomRule | undefined => IDIOM_RULES.find((rule) => rule.id === id);

/* Two tools naming the same file two ways. The scan reports repo-relative paths because that is what ripgrep
 * prints; jscpd prints whatever it was handed, which for a `.` scan is the same path behind a `./`. Normalising
 * here rather than at each comparison keeps the component-overlap chore from quietly matching nothing because one
 * side had two extra characters. */
export const normalizePath = (path: string): string => path.replace(/^\.\//, ``);

// Below this a stem is too short to have survived the stripping above with its meaning intact, `H1` and `H2`
// would both reduce to `h` and read as one family of heading components that are not duplicates of anything.
const MIN_STEM = 3;

const QUALIFIER_PREFIX = /^(base|the)/;
const QUALIFIER_SUFFIX = /(v[0-9]+|new|old|legacy|copy|component|[0-9]+)$/;

/* NAMES THE FRAMEWORK CHOSE, NOT THE AUTHOR, and therefore never evidence of anything.
 *
 * A repository gets one of these per app (`app`, `main`, `root`) or one per route directory (Next's App Router
 * mandates `page`, `layout`, `loading`, `error`, `not-found`, `template`, `default`) BY CONSTRUCTION, so two files
 * sharing one is a fact about the framework and not about duplication. A monorepo with two front-ends has two
 * `App.vue`; a thirty-route Next app has thirty `page.tsx`, which sorts to the top of the families list and becomes
 * the loudest thing the chore says while being entirely false.
 *
 * Same argument as `index` below, and the same disposal. Matched against the whole base name rather than as a
 * prefix, so `AppShell.vue` and `ErrorBoundary.tsx` are ordinary components and keep their own stems: the only
 * files dropped are the ones that could not have been built twice in the first place. */
const FRAMEWORK_NAMES = new Set([`index`, `app`, `main`, `root`, `page`, `layout`, `loading`, `error`, `template`, `default`, `notfound`]);

/* THE NAME TWO COMPONENTS SHARE WHEN THEY ARE THE SAME COMPONENT TWICE, or `undefined` when the file has no
 * name worth comparing.
 *
 * This is a normaliser, not a similarity score, and that is the point: it answers a question the reader can check
 * by eye. `BaseButton.vue` and `ButtonV2.tsx` both reduce to `button`, so a panel claiming they are the same
 * component is making a claim anyone can agree or disagree with in a second. A fuzzy distance would be right more
 * often and checkable never, and an unarguable finding is one nobody can improve.
 *
 * `index` is dropped rather than normalised, along with the rest of the framework's own vocabulary
 * (FRAMEWORK_NAMES). Every barrel file in the repository is called it, and a family of forty index files is a
 * finding about the naming convention rather than about any duplication. */
export const componentStem = (path: string): string | undefined => {
    const file = normalizePath(path).split(`/`).pop() ?? ``;
    // `.component.ts` loses both suffixes, `.vue` loses one, taking everything before the first dot handles both
    // without a table, since a component's name is never the part after a dot.
    const base = (file.split(`.`)[0] ?? ``).toLowerCase().replace(/[^a-z0-9]/g, ``);
    // Tested before the stripping below, so a framework name is dropped on its own terms rather than after a
    // qualifier rule has had a chance to turn it into something else.
    if (base === `` || FRAMEWORK_NAMES.has(base)) {
        return undefined;
    }
    const withoutSuffix = base.replace(QUALIFIER_SUFFIX, ``);
    const stem = (withoutSuffix.length >= MIN_STEM ? withoutSuffix : base).replace(QUALIFIER_PREFIX, ``);
    return stem.length >= MIN_STEM ? stem : base;
};
