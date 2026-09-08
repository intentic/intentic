# Native icon integrations

Versioned patches keep third-party controls and diagrams on native SVG without installing icon packages.

## PrimeVue

The patch replaces fallback icon imports in PrimeVue's ESM modules and Vue sources with local components
that resolve the app's globally registered `Icon`. Drawings remain in `src/icons/`; the patch contains no
artwork. `installUi` must run before mounting controls. Existing icon slots, input semantics, focus behavior
and control events remain PrimeVue's responsibility. The `primevue>@primevue/icons` override removes its
unused dependency. Tests that stand up these controls register `Icon` or the shared `IconStub`.

## Mermaid

The core and ESM icon modules use a native SVG registry. It accepts Mermaid's icon data and loaders, sizes
and transforms their drawings, isolates fragment IDs and passes the result through Mermaid's sanitizer.
The declarations use local SVG types. The `mermaid>@iconify/utils` override removes its unused dependency.
The UI registers its own drawings under `intentic` for diagram references such as `intentic:server`.

## Monaco

The editor's icon stylesheet resolves component names to their semantic defaults and uses the app's SVG
masks. Its base stylesheet no longer loads Codicon's font. The hover-to-cancel progress control keeps its
close mark. The web app installs the masks once in `features/workspace/files/monacoIcons.ts`; code symbols
and search toggles share the kit's paths. A discovery test checks every icon referenced by Monaco's installed
modules, so a library upgrade cannot silently add an unmapped control.

## Updating

After upgrading a library, use `pnpm patch <package>@<version>`, carry the integration into its new
sources, and run `pnpm patch-commit <edit-directory> --patches-dir _editor/ui/patches` from the repo root.
Review changed import paths and public declarations; regenerate the lockfile and run the native icon,
control and Mermaid tests under `_editor/web/src/design-system` and `_editor/web/src/components/Icon.test.ts`.
Run `monacoIcons.integration.test.ts` and a web production build after changing Monaco; the bundle should
contain no Codicon font asset.
The overrides must never remove a dependency while executable imports of it remain in an app entry point.
