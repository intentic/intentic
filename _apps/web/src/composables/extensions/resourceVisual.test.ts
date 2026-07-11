import { ResourceGroupSchema } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { groupAccent, resourceIcon, resourceLogoUrl } from "./resourceVisual";

describe(`resourceIcon`, () => {
    it(`maps representative kinds and falls back to a box for the unknown`, () => {
        expect(resourceIcon(`postgres`)).toBe(`database`);
        expect(resourceIcon(`host`)).toBe(`server`);
        expect(resourceIcon(`komodo`)).toBe(`cog`);
        expect(resourceIcon(`garage-bucket`)).toBe(`folder`);
        expect(resourceIcon(`not-a-real-kind`)).toBe(`box`);
    });
});

describe(`resourceLogoUrl`, () => {
    it(`builds a simple-icons CDN url, using the real slug where it differs from the kind`, () => {
        expect(resourceLogoUrl(`cloudflare`)).toBe(`https://cdn.simpleicons.org/cloudflare`);
        // Slug ≠ kind — exactly the part TypeScript can't guard, so pin it.
        expect(resourceLogoUrl(`postgres`)).toBe(`https://cdn.simpleicons.org/postgresql`);
        expect(resourceLogoUrl(`paperless`)).toBe(`https://cdn.simpleicons.org/paperlessngx`);
        // The `/color` suffix keeps GitHub's near-black mark visible on the dark card.
        expect(resourceLogoUrl(`github`)).toBe(`https://cdn.simpleicons.org/github/f5f5f5`);
        expect(resourceLogoUrl(`gh-ci`)).toBe(`https://cdn.simpleicons.org/github/f5f5f5`);
    });

    it(`has no logo for infra-native / generic / sub-resource kinds → semantic glyph`, () => {
        for (const kind of [
            `host`,
            `tunnel`,
            `cf-route`,
            `komodo`,
            `komodo-server`,
            `deployment`,
            `repo`,
            `ci`,
            `backup`,
            `workspace`,
            `garage-bucket`,
            `postgres-database`,
        ]) {
            expect(resourceLogoUrl(kind)).toBeUndefined();
        }
    });
});

describe(`groupAccent`, () => {
    it(`covers every resource group with a frame + bar`, () => {
        for (const group of ResourceGroupSchema.options) {
            const accent = groupAccent(group);
            expect(accent.frame).toBeTruthy();
            expect(accent.bar).toBeTruthy();
        }
    });
});
