# Languages: how the interface speaks five of them

The editor ships English, German, Spanish, French and Polish. Every word a reader sees now comes from a catalog:
4,869 messages across fifteen of them, one per package that draws something. This page is what you need to add a
string, add a language, or understand why the layer is shaped the way it is.

The whole thing is `_editor/ui/src/i18n/`, reached as `@intentic/ui/i18n`, on top of
[vue-i18n](https://vue-i18n.intlify.dev) 11.

**Where the translations are:** English is written, the other four are seeded from it and awaiting a translator.
`node _tools/checks/i18n-catalogs.mjs` prints the count per catalog (`3888 keys × 5 languages, 0/15552
translated`), so the gap is a number anyone can read rather than a feeling. Nothing renders as a dotted path in the
meantime: a seeded key holds its English text.

## The two rules the design exists to keep

**A reader never watches the words change.** Nothing on screen is in a language until the messages for it have
loaded. On a cold load `main.ts` awaits `startAppI18n()` before `app.mount()`; on a switch, `setLocale` awaits the
fetch and only then assigns the locale. `activate()` in `i18n.ts` is the one place the visible language moves, and
it is a single tick. `index.html`'s pre-paint script writes `<html lang>` before the first paint, so hyphenation,
quote marks and the fallback face are right from the first frame too.

**A fifth language costs the initial download nothing.** English is compiled in — it is also the fallback, and a
fallback cannot be a fetch. Every other language is one chunk per catalog, fetched only by a reader in it. That is
what the literal-template dynamic import is for:

```ts
load: (locale) => import(`./locales/${locale}.json`)
```

Build that path in a variable and the bundler can no longer enumerate the directory: it emits one opaque request
carrying every language, which is the exact growth this layer avoids.

## Writing a string

```ts
const t = useT();                        // in a component's <script setup>
import { t } from "@intentic/ui/i18n";   // in a plain module
```

`t("settings.appearance.look.theme")`, and the message lives in that package's `locales/en.json`. There is no `$t`
in templates: `globalInjection` is off on purpose, because `$t` comes from the plugin and a great many component
tests mount with a bare `createApp` and no plugin, so it would work in the app and fail in the tests. `useT()`
reads the module singleton and works in both.

A count picks between forms, separated by `|`, with the number passed last:

```ts
t(`workspace.savePanel.saveChanges`, { count }, count)   // "Save 1 change" | "Save 3 changes"
```

A sentence with markup inside it stays ONE message, with the markup as slots — never two half-sentences a
translator cannot reorder:

```html
<i18n-t keypath="area.file.seeDocsAt" tag="p" scope="global">
    <template #link><a :href="url">{{ t(`area.file.docs`) }}</a></template>
</i18n-t>
```

### Anything that builds words must be evaluated when it draws

`t` reads the active language from a ref, so it has to be CALLED during render. This is the one rule that decides
how a file is shaped:

| Where the words are | What it takes |
| --- | --- |
| a template | nothing: `{{ t(…) }}` re-renders with the language |
| a list of options in a component | `computed(() => …)` — `SettingsAppearance.vue` is the worked example |
| a table in a plain module | a function: `const statusMeta = () => ({ … })`, called by its accessor |
| a `defineProps` default | it cannot call `t` at all (the compiler hoists defaults out of `setup`): leave the prop optional and resolve the fallback where it is read |

A table built once at import holds the words it was born with and never hears the language change — and at import
time no catalog is registered yet, so it holds the dotted keys instead. `agentStatus.ts`, `vocabulary.ts` and
`connectionNotice.ts` are the pattern: every table is a function, every accessor calls it.

## Adding a language

1. Add it to `LOCALES` in `_editor/ui/src/i18n/locales.ts`, with its endonym — the language's name in itself, which
   is what the picker shows, because a reader hunting for their language reads it in their own.
2. Add its code to `UI_LOCALES` in `_editor/web/index.html`'s pre-paint script. `src/bootLocale.test.ts` fails if
   you forget, and runs the real script against the real `negotiate` to prove the two agree.
3. `node _tools/checks/i18n-catalogs.mjs --fix` creates every catalog's file for it, seeded with the English text.
4. Translate the values. Mind the plural arity: a `|` message written with English's two forms needs Polish's
   three.

## Catalogs

A catalog is one package's slice of the message tree: a directory of `locales/<code>.json` and a `registerCatalog`
call. Five kinds exist.

| Who | Mounts at | Registered by |
| --- | --- | --- |
| the editor | the root — `settings.appearance…` | `_editor/web/src/app/i18n/index.ts` (`appCatalog`) |
| the design system | `ui.` | `_editor/ui/src/i18n/index.ts`, on import |
| the desktop shell | `desktop.` | `_editor/desktop-app/src/i18n/index.ts` |
| the shared conversation page | `share.` | `_editor/share-view/src/i18n/index.ts`, alongside the editor's own, since it compiles the app's chat components in |
| an extension | `ext.<extension id>.` | the host, from the module's `messages` export |

Only the app is at the root; everything else is namespaced, so two packages can never claim the same key. Inside a
catalog a key reads `<area>.<file>.<what it says>`: the feature directory, the component that draws it, and a name
made from the English. `src/core-views` is `views.`, `src/shell` is `shell.`, `src/components` is `common.`.

A component test mounts without the app's boot, so `bun.setup.ts` registers `appCatalog` for every suite; an
extension test that calls `activate` itself registers its own with `registerExtensionMessages`. Without that, a text
assertion reads a dotted key instead of the words.

## What keeps it honest

Four gates, none of which is the compiler — **vue-i18n's `t` takes any string**, whatever `DefineLocaleMessage`
says, so a typo'd key is not a build error:

- `i18n-catalogs.mjs` (gate: code): every language holds exactly the keys English does. The app loads one pack
  rather than the pack plus English, which is what keeps a fifth language off the initial download; the price is
  that a key missing from `pl.json` has nothing to fall back to and renders as its own dotted path. `--fix` seeds
  new keys with their English text, drops keys English no longer has, and sorts.
- `i18n-keys.mjs` (gate: code, needs node_modules): every `t()` key and every `<i18n-t keypath>` resolves in a
  catalog that file can read, no catalog carries a message nobody asks for, and every message compiles — `@` is
  vue-i18n's link syntax, `|` its plural separator and `{` its placeholder, so a message carrying one of them
  throws at the first render that needs it.
- `i18n-literals.mjs` (gate: tidy, needs node_modules): no English typed into a template. Text nodes, the
  attributes that are drawn as words, `v-tooltip`, and the literals inside a `{{ }}` or a bound attribute, all
  judged by one rule in `_tools/checks/lib/visible-text.mjs`.
- `vue-templates.mjs` reads every template with the real compiler, so a rewrite that does not compile cannot land.

## Extensions

An extension exports `messages` alongside `activate`; the host registers it and **awaits it before calling
`activate`**, because `activate` is where the extension registers the panels and commands whose titles it has just
translated.

```ts
// src/i18n.ts
export const messages: ExtensionMessages = { base, load: (locale) => import(`./locales/${locale}.json`) };
export const t = extensionT(extensionIdOf(manifest));
```

`_extensions/activity` is the worked example, and eleven bundled extensions carry one. An extension's keys are its
own (`t("title")`), and they are strings rather than a checked union — its catalog belongs to its own package and the
host's schema has never seen it.

A contribution's label is a string handed to the host inside `activate`, not a binding the host can re-read, so
`useExtensionHost.ts` retires and reloads extensions when the language changes. That is blunt and it is correct: it
runs only after the new language's messages are already loaded, and a reader changes language about once.

An extension with no `src/index.ts` ships no editor bundle at all (`google-workspace`, the chat gateways): its words
are the daemon's, and nothing here reaches them.

## What is not translated

- **The message compiler stays bundled** (no `@intlify/unplugin-vue-i18n` precompile step). Extensions installed
  from a repository ship plain JSON this app has never seen at build time; without the compiler their strings cannot
  render at all. Given it ships anyway, precompiling our own would trade sub-millisecond parse time for a larger AST
  payload and a plugin in four Vite configs.
- **Dates, numbers and relative times are CLDR's, not ours.** `@intentic/ui/format` rebuilds its `Intl` formatters
  whenever `setLocale` runs, and `timeAgo` is `Intl.RelativeTimeFormat` — so "5m ago" is "vor 5 Min." and "2 dni
  temu" with no translator involved, and Polish's four plural forms are ICU's problem rather than ours. The 24-hour
  clock stays pinned across every language: that is a house style, not something a locale gets to answer.
- **Language names in the picker**, which are always written in themselves.
- **Brand names** (`GitHub`, `Docker`, the product's own wordmark) and **code tokens**: a path, a command, a config
  key, anything in a `font-mono` span or a `<code>`. `visible-text.mjs` knows both shapes and skips them.
- **Enum values that happen to be English words** — `save="explicit"`, `action="Rebuild"` — which a component
  switches on. Translating one would break the component, not localize it.
- **Prompts sent to a model**: a workflow template's instructions, an automation's prompt. The reader can edit them;
  the model reads them.
- **The dev-only design kit** (`features/settings/DesignKit.vue`), which no reader is shipped.
- **Manifest labels.** An extension's `intentic-extension.json` declares contribution labels (`views[].label`,
  listener event names) that the host draws as typed. They are the one user-visible surface still in English only:
  translating them needs a `%key%` convention in the manifest schema, resolved against the extension's catalog when
  the host reads its contributions.
