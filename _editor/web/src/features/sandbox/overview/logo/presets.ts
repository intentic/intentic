import { glyphBody } from "@intentic/ui/glyph";
import { ICONS } from "@intentic/ui/icons";

export const LOGO_ICONS = [
    `box`, `robot`, `code`, `terminal`, `globe`, `flask`,
    `book`, `folder`, `cloud`, `database`, `shield`, `bolt`,
    `star`, `sparkles`, `sun`, `moon`, `palette`, `gift`,
] as const;

export interface LogoStyle {
    icon: (typeof LOGO_ICONS)[number];
    color: string;
}

const PREFIX = `data:image/svg+xml,`;

// A normal sandbox image, so the existing API and every logo surface can use it unchanged. The marker lets this
// picker recover its choices when reopened; an uploaded image remains an uploaded image.
export const logoStyleImage = ({ icon, color }: LogoStyle): string => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" data-intentic-logo="${icon}:${color}">
        <rect width="64" height="64" rx="14" fill="${color}" fill-opacity=".14"/>
        <g transform="translate(12 12) scale(1.666667)" color="${color}">${glyphBody(ICONS[icon])}</g>
    </svg>`;
    return `${PREFIX}${encodeURIComponent(svg)}`;
};

export const readLogoStyle = (image: string | null | undefined): LogoStyle | undefined => {
    if (!image?.startsWith(PREFIX)) {
        return undefined;
    }
    let svg: string;
    try {
        svg = decodeURIComponent(image.slice(PREFIX.length));
    } catch (cause) {
        // Bad percent escapes identify a custom or damaged image, which has no preset to restore.
        if (cause instanceof URIError) {
            return undefined;
        }
        throw cause;
    }
    const match = /data-intentic-logo="([a-z-]+):(#[0-9a-f]{6})"/i.exec(svg);
    const icon = LOGO_ICONS.find((candidate) => candidate === match?.[1]);
    return icon === undefined || match?.[2] === undefined ? undefined : { icon, color: match[2] };
};
