// Protocol version matched by engines.intentic at load and reported as IntenticApi.apiVersion.
// Bump with the published package: additive surface changes require a minor, breaking changes a major.
// Keep published names compatible within a major; surface.json and the surface checks record API and UI-kit changes.
// 2.35.0 lets a command declare its shortcut as a Mac spells it: `mac` beside `keybinding` in `contributes.commands`,
// approved at install as a power of its own (a second chord the extension claims). Without one a Mac uses `keybinding`,
// as before; with one, a Mac binds `mac` instead. Whichever is declared, a Mac's text field keeps the chords it answers
// itself (⌃A, ⌃K, ⌥←, ⌘⌫). Additive: a manifest without `mac` is unchanged. The recorded surface grows the manifest
// schema.
// 2.36.0 records settings choice labels and explanations alongside the Mac shortcut schema.
// 2.37.0 adds the kit's own day and time fields, `DatePicker` and `TimeField`, in place of the browser's date popup and
// hour spinner. Additive.
export const extensionApiVersion = "2.37.0";
