// THE BRIEF A HARDENING SESSION STARTS FROM (PrivacyLeaks.vue's Harden press): the leaks the owner confirmed, read
// through the agent's own `privacy` CLI, turned into rules and name-list words it measures and proposes; the owner
// applies them. English, since it is the agent's to read, and never a value: the agent reads the leaks itself, as its
// provider may (schemas/privacy-leaks.ts). Its one fork is the provider: an untrusted one is told it sees outlines only,
// so it neither asks for a value nor goes looking for one.

export interface HardeningCounts {
    readonly confirmed: number;
    readonly suspected: number;
    // Whether the run's provider may read personal data as it is (trusted, or local).
    readonly trusted: boolean;
}

const OUTLINES_ONLY =
    ` This conversation's provider is not trusted, so you see each leak as its outline (AA9999999), the field label before it ` +
    `and what the name lists say of each word, never its value. Do not ask for values and do not try to read them anywhere else.`;

export const hardeningPrompt = ({ confirmed, suspected, trusted }: HardeningCounts): string =>
    [
        `Harden this sandbox's privacy shield against the leaks reported here: values that reached a model provider unmasked. ` +
            `There ${confirmed === 1 ? `is` : `are`} ${String(confirmed)} confirmed and ${String(suspected)} suspected.`,
        ``,
        `1. Run \`privacy leaks\`. Each confirmed leak is already masked as its exact value; your job is to make the shield catch the next value like it.${ 
            trusted ? `` : OUTLINES_ONLY}`,
        `2. Sort each leak into one of three: specific to this sandbox's data (a customer-number format, a document number under a known label, ` +
            `the surnames this data holds): write a rule or name-list words for it; a gap in the shield's own detectors (a format any sandbox would meet): ` +
            `describe it by its outline in your final reply so the owner can report it, and add a local rule only if the data needs it now; ` +
            `skipped by design (a reserved example domain, a number whose check digit fails): say so and change nothing.`,
        `3. Write candidate rules and lists to a JSON file under /tmp (\`privacy --help\` shows the format; name a leak's word as {"leak": "L3", "word": 1}) ` +
            `and measure it with \`privacy try <file>\`. Catch the confirmed leaks while masking as little else as you can: read the samples it shows ` +
            `and tighten anything that matches ordinary text. Prefer patterns anchored on the field label.`,
        `4. When it measures well, run \`privacy propose <file> --title "…" --why "…"\`. The owner applies it on the privacy page; you cannot change the policy yourself.`,
        `5. Suspected leaks are the owner's to confirm. Leave them, but mention any that look like the same kind as a confirmed one.`,
        ``,
        `End with a short summary: what you proposed and what it measured, the detector gaps you found, and what you left alone and why.`,
    ].join(`\n`);
