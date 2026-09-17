import type { PickerGroup } from "@intentic/ui";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { t } from "@intentic/ui/i18n";

// The phones the preview can stand in for. Sizes are the CSS viewport each device reports to a page in portrait — the
// numbers a media query sees, not physical pixels — so a layout framed here breaks where it would break on the device.
// The rest of each row is the shell drawn around that viewport.

// Where the camera sits on the screen, which is the one feature that tells two black slabs apart.
export type PhoneCutout = `island` | `notch` | `punch` | `none`;

export interface PhoneModel {
    readonly id: string;
    readonly label: string;
    /** Picker heading; phones of one make sit together. */
    readonly brand: string;
    /** CSS viewport width in portrait, px. */
    readonly width: number;
    /** CSS viewport height in portrait, px. */
    readonly height: number;
    /** Screen corner radius at 1:1, px. */
    readonly radius: number;
    readonly cutout: PhoneCutout;
    /** Bezel down each side, px. */
    readonly bezel: number;
    /** Bezel above and below; only a home-button phone sets it, and it is that phone's forehead and chin. */
    readonly chin?: number;
}

export const phoneModels = (): readonly PhoneModel[] => [
    {
        id: `iphone-se`,
        label: t(`preview.phoneModels.iphoneSe`),
        brand: `Apple`,
        width: 375,
        height: 667,
        radius: 4,
        cutout: `none`,
        bezel: 12,
        chin: 56,
    },
    {
        id: `iphone-13-mini`,
        label: t(`preview.phoneModels.iphone13Mini`),
        brand: `Apple`,
        width: 375,
        height: 812,
        radius: 42,
        cutout: `notch`,
        bezel: 11,
    },
    { id: `iphone-15`, label: t(`preview.phoneModels.iphone15`), brand: `Apple`, width: 393, height: 852, radius: 47, cutout: `island`, bezel: 11 },
    {
        id: `iphone-15-pro-max`,
        label: t(`preview.phoneModels.iphone15ProMax`),
        brand: `Apple`,
        width: 430,
        height: 932,
        radius: 53,
        cutout: `island`,
        bezel: 11,
    },
    { id: `pixel-7`, label: t(`preview.phoneModels.pixel7`), brand: `Google`, width: 412, height: 915, radius: 28, cutout: `punch`, bezel: 10 },
    {
        id: `pixel-8-pro`,
        label: t(`preview.phoneModels.pixel8Pro`),
        brand: `Google`,
        width: 448,
        height: 998,
        radius: 32,
        cutout: `punch`,
        bezel: 10,
    },
    { id: `galaxy-s24`, label: t(`preview.phoneModels.galaxyS24`), brand: `Samsung`, width: 360, height: 780, radius: 26, cutout: `punch`, bezel: 9 },
    {
        id: `galaxy-s24-ultra`,
        label: t(`preview.phoneModels.galaxyS24Ultra`),
        brand: `Samsung`,
        width: 384,
        height: 824,
        radius: 14,
        cutout: `punch`,
        bezel: 9,
    },
];

// Mid-range current iPhone: the size most phone traffic is within a few px of.
export const DEFAULT_PHONE_ID = `iphone-15`;

const fallback = (): PhoneModel => phoneModels().find((phone) => phone.id === DEFAULT_PHONE_ID) ?? phoneModels()[0]!;

/** An unknown id (a dropped model, a hand-edited store) resolves to the default rather than an empty stage. */
export const phoneById = (id: string | undefined): PhoneModel => phoneModels().find((phone) => phone.id === id) ?? fallback();

export const phonePickerGroups = (): readonly PickerGroup[] => {
    const brands = [...new Set(phoneModels().map((phone) => phone.brand))];
    return brands.map((brand) => ({
        label: brand,
        options: phoneModels()
            .filter((phone) => phone.brand === brand)
            .map((phone) => ({
                value: phone.id,
                label: phone.label,
                description: `${phone.width} × ${phone.height}`,
            })),
    }));
};

/** Screen plus bezel: what has to fit on screen, before scaling. */
export const phoneOuterSize = (phone: PhoneModel): { readonly width: number; readonly height: number } => ({
    width: phone.width + phone.bezel * 2,
    height: phone.height + (phone.chin ?? phone.bezel) * 2,
});

// Largest scale at which the whole device fits the pane, capped at 1:1 — a phone shown larger than life reads as a
// tablet and flatters every tap target on it. An unmeasured pane (first tick, no ResizeObserver) reads as 1:1.
export const phoneScale = (phone: PhoneModel, pane: { readonly width: number; readonly height: number }): number => {
    if (!(pane.width > 0) || !(pane.height > 0)) {
        return 1;
    }
    const outer = phoneOuterSize(phone);
    return Math.min(1, pane.width / outer.width, pane.height / outer.height);
};

// The chosen phone outlives a reload and is not per-sandbox: which handset someone reviews on is a fact about them.
const PHONE_KEY = `intentic-preview-phone`;

export const storedPhoneId = (): string => storedValue(PHONE_KEY) ?? DEFAULT_PHONE_ID;
export const storePhoneId = (id: string): void => storeValue(PHONE_KEY, id);
