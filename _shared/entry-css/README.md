# @intentic/entry-css

The **entry skin**: the composition a person meets in their first minute here, dressed as the page they
arrived from. The site's metals and ink laid over the design system's role tokens, the flat display face,
the gold eyebrow and lozenge, the framed plate with its turned corners and lotus finial, and the two button
plaques — all scoped to `.entry`, and therefore inert on every screen that does not ask for it.

## Who wears it

| consumer                                       | what it is                                                    |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `_editor/web/src/features/auth/Login.vue`      | `/login` — the door                                            |
| `_editor/web/src/features/setup/Setup.vue`     | `/setup` — the room behind it, where a sandbox is chosen        |
| `_editor/desktop-app/src/App.vue`              | the launcher window that `/setup` hands the install to          |

Those three are one continuous minute: pick a machine on `/setup`, press **Set it up now**, and the desktop
window takes the screen over. It lived in `_editor/web/src/styles/` while the first two were the only
wearers; the third is in another package, so the material moved to where both can reach it — the same move
`house.css` made when the site, the entry screens and the Sanctum skin were each carrying their own bronze.

## What it is made of, and what it is not

**Material from `house.css`, composition here.** Engraved gold, the cartouche frame kit and the ember glows are
`--house-*` properties on `:root` and belong to [`@intentic/house-css`](../house-css/README.md). This sheet
decides what is made of them: which surface is a plate, which rule is gold, how big a corner is, what a
primary button looks like on this ground. The display face's flat ink lives here as `--display-ink`.

**`--color-*`, never `--role-*`.** A custom property's `var()` is substituted where it is *declared*, so
re-pointing `--role-canvas` from a descendant of `:root` changes nothing — the semantic layer already
resolved it. `.entry` restates the `--color-*` tokens the design system reads, which is why a
design-system component dropped inside an entry screen comes out in the site's metals without knowing it.

**Two schemes, keyed on the scheme.** The light block at the foot is not an afterthought: a reader who came
from `intentic.dev/desk` has been reading a light page, and anyone who chose Light in Settings is a light
reader whatever brought them. `_site/site/scripts/check-desk-palette.mjs` fails the build if those values
drift from the site's own.

**No plate art in the launcher.** `.entry-plate` reaches for `/assets/angkor/*.avif`, which only the web app
serves. The desktop window uses the ground, the metals, the type and the frame kit, and leaves the
photograph to the two full-page screens.

**Consumed by relative path.** `@import "../../../_shared/entry-css/entry.css";` — the repo's convention for
cross-package CSS. The `workspace:*` dependency in each consumer's `package.json` states the edge; the
stylesheet resolver walks the path. It is imported **after** the skins, and the Sanctum skin excludes
`.entry` from its route backdrop by name.
