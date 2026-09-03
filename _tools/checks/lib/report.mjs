/* HOW A CHECK ANSWERS: sections of problems to stderr and exit 1, or one line per thing it vouched for to
 * stdout and exit 0. Every check in this directory is its own process with this contract, which is what lets
 * run.mjs run them side by side and lets any one of them be run alone by hand.
 *
 * Every report before any exit, so one run says everything that is wrong rather than the first thing. */

// `sections` is `[heading, lines[]]` pairs; `vouched` is what to print when nothing is wrong.
export const finish = (sections, vouched) => {
    const failing = sections.filter(([, lines]) => lines.length > 0);
    if (failing.length > 0) {
        for (const [heading, lines] of failing) {
            console.error(`${heading}:\n${lines.map((line) => `  - ${line}`).join("\n")}`);
        }
        process.exit(1);
    }
    for (const line of vouched) {
        console.log(line);
    }
};
