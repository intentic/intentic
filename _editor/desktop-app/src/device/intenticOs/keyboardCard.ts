import type { IntenticOsKeyboardLayout, IntenticOsKeyboardLayouts, IntenticOsKeyboardStatus } from "@intentic/sandbox-contract/schemas/intentic-os";
import type { PickerOption } from "@intentic/ui";

// THE KEYBOARD, READ (src-tauri/src/os_settings.rs runs `ic os keyboard`, settings.ts holds it, KeyboardCard.vue draws it):
// the layout in use by its name, every layout to pick from in alphabetical order, and the variants of the one picked.
// Pure, so each case is tested by value (keyboardCard.test.ts).

/** The variant picker's value for a layout's own, which `ic os keyboard set` takes as no `--variant` at all. */
export const STANDARD = ``;

/** What the layout in use is called: the system's name for it, else the picked layout's, else its code. */
export const keyboardNameOf = (status: IntenticOsKeyboardStatus, layouts: IntenticOsKeyboardLayouts | undefined): string => {
    if (status.name !== null) {
        return status.name;
    }
    const layout = layouts?.layouts.find((each) => each.layout === status.layout);
    const variant = layout?.variants.find((each) => each.variant === status.variant);
    return variant?.name ?? layout?.name ?? status.layout;
};

const byName = (one: { readonly name: string }, other: { readonly name: string }): number => one.name.localeCompare(other.name);

/** Every layout, by name, alphabetically: the system's own order is by code, which nobody searches by. */
export const layoutOptionsOf = (layouts: IntenticOsKeyboardLayouts): PickerOption[] =>
    [...layouts.layouts].sort(byName).map((layout) => ({ value: layout.layout, label: layout.name }));

/** A layout's variants by name, after its own. None to pick where it has none. */
export const variantOptionsOf = (layout: IntenticOsKeyboardLayout | undefined, standard: string): PickerOption[] =>
    layout === undefined || layout.variants.length === 0
        ? []
        : [{ value: STANDARD, label: standard }, ...[...layout.variants].sort(byName).map((variant) => ({ value: variant.variant, label: variant.name }))];

export const layoutOf = (layouts: IntenticOsKeyboardLayouts | undefined, code: string): IntenticOsKeyboardLayout | undefined =>
    layouts?.layouts.find((layout) => layout.layout === code);
