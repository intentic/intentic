// Table of UI frameworks and idiom-migration rules that probes.ts sweeps and chores.ts turns into findings; kept apart
// so neither duplicates the other's patterns.
// Patterns are Rust-regex via ripgrep: no literal apostrophe (match quotes as `[\x22\x27]`; the scan shell-quotes each
// pattern) and no lookaround (use `absent` for a file-level question instead).
// A pattern names a framework or idiom only; whether it is worth fixing is chores.ts's judgement.

export interface UiFramework {
    readonly id: string;
    readonly label: string;
    // Dependency names that mean this repo is built with it; any one match is enough.
    readonly packages: readonly string[];
}

// The three frameworks with idiom rules defined below; a table entry with no rules gives a chore nothing to report.
export const UI_FRAMEWORKS: readonly UiFramework[] = [
    { id: `react`, label: `React`, packages: [`react`] },
    { id: `vue`, label: `Vue`, packages: [`vue`] },
    { id: `angular`, label: `Angular`, packages: [`@angular/core`] },
];

// Not a UI framework: a styling system any of the three above can use; gates exactly one chore.
export const TAILWIND_PACKAGES: readonly string[] = [`tailwindcss`];

export const frameworksOf = (deps: readonly string[]): UiFramework[] =>
    UI_FRAMEWORKS.filter((framework) => framework.packages.some((name) => deps.includes(name)));

export const usesTailwind = (deps: readonly string[]): boolean => TAILWIND_PACKAGES.some((name) => deps.includes(name));

// Dirs a UI scan must skip, spelled out rather than relying on .gitignore; also excludes test/spec/story files.
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

// Component file extensions across all three frameworks; the sweep is one fixed command for every repo.
export const COMPONENT_GLOBS: readonly string[] = [`*.vue`, `*.tsx`, `*.jsx`, `*.component.ts`];

// Where a Tailwind class can appear; wider than COMPONENT_GLOBS since plain markup like .html carries classes too.
export const MARKUP_GLOBS: readonly string[] = [`*.vue`, `*.tsx`, `*.jsx`, `*.html`, `*.svelte`, `*.astro`];

// Matches only bypass values: a raw color or px size; leading `-` anchors to a utility prefix, not prose text.
export const BYPASS_PATTERN = `-\\[(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\\(|[0-9]+(\\.[0-9]+)?px)`;

export interface IdiomRule {
    readonly id: string;
    // Which framework's migration this belongs to.
    readonly framework: string;
    // Named the way a person reading it would say it, not a code term.
    readonly label: string;
    // The destination the agent should move to, not merely what it is leaving.
    readonly replacement: string;
    readonly pattern: string;
    readonly globs: readonly string[];
    // Marks a rule as absence-based: the file is on the old idiom because `pattern` (the new one) never appears.
    readonly absent?: true;
}

// Idioms still functional but steered away from by their frameworks; patterns favor precision over coverage.
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
        // Named for what it is, not the UNSAFE_ prefix a reader may not recognize.
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
        // New idiom, inverted via `absent`: no `<script setup>` (or no script at all) reads as unmigrated.
        pattern: `<script[^>]*\\bsetup\\b`,
        globs: [`*.vue`],
        absent: true,
    },
    {
        id: `vue-2-lifecycle`,
        framework: `vue`,
        label: `the Vue 2 teardown hooks`,
        replacement: `beforeUnmount and unmounted`,
        // .vue only: hook belongs to a component. `destroyed` counts only as a function, not a field or type.
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

// Strips a leading `./`: ripgrep prints repo-relative paths, jscpd's `.` scan prints the same path with `./` prepended.
export const normalizePath = (path: string): string => path.replace(/^\.\//, ``);

// Below this a stem lost its meaning in stripping; `H1`/`H2` would both reduce to `h`.
const MIN_STEM = 3;

const QUALIFIER_PREFIX = /^(base|the)/;
const QUALIFIER_SUFFIX = /(v[0-9]+|new|old|legacy|copy|component|[0-9]+)$/;

// Names the framework mandates per app or route; sharing one is never evidence of duplication.
const FRAMEWORK_NAMES = new Set([`index`, `app`, `main`, `root`, `page`, `layout`, `loading`, `error`, `template`, `default`, `notfound`]);

// Normalizes a file name to a comparison key, not a similarity score, so a match is one a reader can check by eye;
// framework names and `index` are dropped since barrels and route files share them by convention.
export const componentStem = (path: string): string | undefined => {
    const file = normalizePath(path).split(`/`).pop() ?? ``;
    // First-dot split handles both `.component.ts` and `.vue` suffixes; a component's name never follows a dot.
    const base = (file.split(`.`)[0] ?? ``).toLowerCase().replace(/[^a-z0-9]/g, ``);
    // Framework names are dropped before qualifier stripping runs, on their own terms.
    if (base === `` || FRAMEWORK_NAMES.has(base)) {
        return undefined;
    }
    const withoutSuffix = base.replace(QUALIFIER_SUFFIX, ``);
    const stem = (withoutSuffix.length >= MIN_STEM ? withoutSuffix : base).replace(QUALIFIER_PREFIX, ``);
    return stem.length >= MIN_STEM ? stem : base;
};
