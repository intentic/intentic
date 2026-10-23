import { ImageDataUrlSchema } from "@intentic/api-contract";
import { LOGO_ICONS, logoStyleImage, readLogoStyle } from "./presets";

it.each([...LOGO_ICONS])(`stores and restores %s through the existing sandbox image contract`, (icon) => {
    const style = { icon, color: `#e07400` };
    const image = logoStyleImage(style);
    expect(ImageDataUrlSchema.parse(image)).toBe(image);
    expect(readLogoStyle(image)).toEqual(style);
});

it.each([
    null,
    undefined,
    `data:image/webp;base64,UPLOADED`,
    `data:image/svg+xml,%`,
    `data:image/svg+xml,${encodeURIComponent(`<svg data-intentic-logo="missing:#123456"/>`)}`,
    `data:image/svg+xml,${encodeURIComponent(`<svg data-intentic-logo="box:red"/>`)}`,
])(`does not treat a custom or malformed image as a preset: %s`, (image) => {
    expect(readLogoStyle(image)).toBeUndefined();
});
