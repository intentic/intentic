import { moduleHue } from "../../lib/identityHue";
import { sessionKind, sessionModule } from "./sessionKind";

describe(`sessionKind`, () => {
    it(`draws the everyday single agent as a dot, and a child too, since it stands under its parent`, () => {
        expect(sessionKind({ id: `calm-reef-1234` })).toMatchObject({ name: `solo`, icon: undefined });
        expect(sessionKind(undefined)).toMatchObject({ name: `solo`, icon: undefined });
        expect(sessionKind({ id: `c2`, startedBy: `agent:calm-reef-1234` })).toMatchObject({ name: `child`, icon: undefined });
    });

    it(`gives every rarer kind a glyph of its own`, () => {
        expect(sessionKind({ id: `home-abc`, home: true }).icon).toBe(`home`);
        expect(sessionKind({ id: `c1`, subagents: { running: 0, total: 3 } }).icon).toBe(`subagents`);
        expect(sessionKind({ id: `c1`, fresh: { of: `c0`, kind: `review`, at: 1 } }).icon).toBe(`eye`);
        expect(sessionKind({ id: `c1`, fresh: { of: `c0`, kind: `test`, at: 1 } }).icon).toBe(`flask`);
        expect(sessionKind({ id: `c1`, forkedFrom: { conversationId: `c0`, index: 2, files: `then` } }).icon).toBe(`fork`);
        expect(sessionKind({ id: `ci-fix-intentic-37292817794` }).name).toBe(`fixer`);
    });

    it(`draws an automation by where it came from: a schedule's clock, a webhook's bolt`, () => {
        expect(sessionKind({ id: `a-x-1`, origin: { automationId: `x-follow`, provider: `schedule` } })).toMatchObject({ name: `automation`, icon: `clock` });
        expect(sessionKind({ id: `a-hook-1`, origin: { automationId: `deploy`, provider: `webhook` } }).icon).toBe(`bolt`);
    });

    it(`names the most particular kind: a home or an automation's run stays that whoever it spawns`, () => {
        expect(sessionKind({ id: `home-abc`, home: true, subagents: { running: 2, total: 2 } }).name).toBe(`home`);
        expect(sessionKind({ id: `a-x-1`, origin: { automationId: `x`, provider: `schedule` }, subagents: { running: 0, total: 1 } }).name).toBe(
            `automation`,
        );
        expect(sessionKind({ id: `c2`, startedBy: `agent:c1`, subagents: { running: 1, total: 1 } }).name).toBe(`orchestrator`);
    });
});

describe(`sessionModule`, () => {
    it(`colours by the most-changed package`, () => {
        expect(sessionModule({ id: `c1`, modules: [`@intentic/web`, `@intentic/ui`] })).toEqual({ name: `@intentic/web`, hue: moduleHue(`@intentic/web`) });
    });

    it(`is nothing for a session that has changed nothing`, () => {
        expect(sessionModule({ id: `c1` })).toBeUndefined();
        expect(sessionModule(undefined)).toBeUndefined();
    });

    it(`keeps one package's colour, and off the hues a card's standing speaks in`, () => {
        expect(moduleHue(`@intentic/web`)).toBe(moduleHue(`@intentic/web`));
        for (const name of [`web`, `sandbox`, `ui`, `desktop-app`, `automations`, `webext`, `site`, `docs`]) {
            const hue = moduleHue(name);
            // Red, the brand's orange, amber and green: what the rim and the corner's pill say a verdict in.
            expect(hue < 15 || (hue > 60 && hue < 110) || (hue > 170 && hue < 320)).toBe(true);
        }
    });
});
