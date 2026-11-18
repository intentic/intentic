// ZOD COMPILES A PARSER ONLY FOR AN ANSWER THAT KEEPS COMING BACK (2026-11-18). The first time an object schema parses,
// zod writes a parser for its shape and compiles it with `new Function`, so the page pays for that compile, and for V8
// compiling the code it wrote, before the answer is read. That pays off for a schema parsed again and again and is pure
// cost for one parsed once, and a page load parses dozens of answers once each. In a profile of the demo build at 4x CPU
// throttling the compiles were ~70 ms of the ~180 ms the start spent parsing answers. So a route's first COMPILE_AFTER
// answers are parsed with zod's `jitless`: the same schema, the same result, through its interpreted path. After that
// the route counts as hot, a poll for instance, and gets the compiled parser. On a cold load of the demo build that took
// 4-6% off the main thread's work before the first view (31-47 ms of 708-744 ms, 15-20 interleaved loads a side).
// Interpreted parsing costs 1.3x the compiled parser (8 µs more per answer, averaged over 295 answers the demo serves,
// each read identically both ways), which only a hot route repeats often enough to notice.
const COMPILE_AFTER = 3;

// allow(module-state): how many answers each route has had parsed in this page, which is what makes it hot
const parsed = new Map<string, number>();

/** The parse options for a route's next answer: interpreted (`jitless`) until the route has answered COMPILE_AFTER times. */
export const answerParseOptions = (route: string): { readonly jitless: true } | undefined => {
    const count = (parsed.get(route) ?? 0) + 1;
    parsed.set(route, count);
    return count > COMPILE_AFTER ? undefined : { jitless: true };
};
