# Languages: how the interface speaks five of them

The editor ships English, German, Spanish, French and Polish. This page is what you need to add a string, add a
language, or understand why the layer is shaped the way it is.

The whole thing is `_editor/ui/src/i18n/`, reached as `@intentic/ui/i18n`, on top of
[vue-i18n](https://vue-i18n.intlify.dev) 11.

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
const t = useT();          // in a component's <script setup>
import { t } from "@intentic/ui/i18n";   // in a plain module
```

`t("settings.appearance.look.theme")` — keys are checked against `locales/en.json`, so a typo is a build error
rather than a blank label someone finds in production.

There is no `$t` in templates. `globalInjection` is off on purpose: `$t` comes from the plugin, and a great many
component tests mount with a bare `createApp` and no plugin, so `$t` would work in the app and fail in the tests.
`useT()` reads the module singleton and works in both.

**Anything that builds a list of labels must be a `computed`.** `t` reads the active language from a ref; a list
built once during setup holds the words it was born with and never hears the language change. `SettingsAppearance.vue`
is the worked example.

## Adding a language

1. Add it to `LOCALES` in `_editor/ui/src/i18n/locales.ts`, with its endonym — the language's name in itself, which
   is what the picker shows, because a reader hunting for their language reads it in their own.
2. Add its code to `UI_LOCALES` in `_editor/web/index.html`'s pre-paint script. `src/bootLocale.test.ts` fails if
   you forget, and runs the real script against the real `negotiate` to prove the two agree.
3. `node _tools/checks/i18n-catalogs.mjs --fix` creates every catalog's file for it, seeded with the English text.
4. Translate the values.

## Catalogs

A catalog is one package's slice of the message tree: a directory of `locales/<code>.json` and a `registerCatalog`
call. Three kinds exist.

| Who | Mounts at | Registered by |
| --- | --- | --- |
| the editor | the root — `settings.appearance…` | `_editor/web/src/app/i18n/index.ts` |
| the design system | `ui.` | `_editor/ui/src/i18n/index.ts`, on import |
| an extension | `ext.<extension id>.` | the host, from the module's `messages` export |

Only the app is at the root; everything else is namespaced, so two packages can never claim the same key.

`_tools/checks/i18n-catalogs.mjs` gates the invariant that makes the single-pack download safe: **every language
holds exactly the keys English does.** Since the app loads one pack rather than the pack plus English, a key missing
from `pl.json` has nothing to fall back to and renders as its own dotted path, in front of a reader. `--fix` seeds
new keys with their English text, drops keys English no longer has, and sorts — run it before a translation pass and
after one. Its output also reports how much of each catalog is still verbatim English.

## Extensions

An extension exports `messages` alongside `activate`; the host registers it and **awaits it before calling
`activate`**, because `activate` is where the extension registers the panels and commands whose titles it has just
translated.

```ts
// src/i18n.ts
export const messages: ExtensionMessages = { base, load: (locale) => import(`./locales/${locale}.json`) };
export const t = extensionT(extensionIdOf(manifest));
```

`_extensions/activity` is the worked example. An extension's keys are its own (`t("title")`), and they are strings
rather than a checked union — its catalog belongs to its own package and the host's schema has never seen it.

A contribution's label is a string handed to the host inside `activate`, not a binding the host can re-read, so
`useExtensionHost.ts` retires and reloads extensions when the language changes. That is blunt and it is correct: it
runs only after the new language's messages are already loaded, and a reader changes language about once.

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
