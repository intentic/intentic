import { hardeningPrompt } from "./privacyHardening";

// The hardening session's brief: the counts it starts from, and the one sentence an untrusted provider must read.

const OUTLINE_RULE = `never its value. Do not ask for values`;

describe(`the brief a hardening session starts from`, () => {
    test(`says how many leaks are confirmed and how many suspected`, () => {
        const prompt = hardeningPrompt({ confirmed: 3, suspected: 2, trusted: true });
        expect(prompt).toContain(`There are 3 confirmed and 2 suspected.`);
    });

    test(`agrees with a single confirmed leak`, () => {
        expect(hardeningPrompt({ confirmed: 1, suspected: 0, trusted: true })).toContain(`There is 1 confirmed and 0 suspected.`);
    });

    test(`tells an untrusted provider it reads outlines only, and not to go looking for values`, () => {
        const prompt = hardeningPrompt({ confirmed: 2, suspected: 0, trusted: false });
        expect(prompt).toContain(`This conversation's provider is not trusted`);
        expect(prompt).toContain(OUTLINE_RULE);
    });

    test(`says nothing of outlines to a trusted one, which reads the values`, () => {
        const prompt = hardeningPrompt({ confirmed: 2, suspected: 0, trusted: true });
        expect(prompt).not.toContain(`not trusted`);
        expect(prompt).not.toContain(OUTLINE_RULE);
    });

    test(`walks the five steps in order, from reading the leaks to proposing`, () => {
        const prompt = hardeningPrompt({ confirmed: 1, suspected: 1, trusted: false });
        const steps = [`1. Run \`privacy leaks\``, `2. Sort each leak`, `3. Write candidate rules`, `4. When it measures well`, `5. Suspected leaks`];
        const at = steps.map((step) => prompt.indexOf(step));
        expect(at.every((index) => index >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        expect(prompt).toContain(`privacy propose <file>`);
    });
});
