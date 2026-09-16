/* HOW A CHECK ANSWERS: sections of problems to stderr and exit 1, or one line per thing it vouched for to stdout and exit 0.
   A third answer, exit 2: it could not measure at all. */

// The check never got to judge anything — its own tool moved under it, or the environment is missing something it needs.
// Exit 2 rather than 1, because "the tree is bad" and "I did not look" are different facts and a caller that cannot tell
// them apart has to choose between blocking everyone on a broken tool and quietly not testing the thing any more. Both
// have happened here: `pnpm peers check`'s output shape moved and reddened the nightly with nothing wrong in the tree.
export const cannotMeasure = (why) => {
    console.error(why);
    process.exit(2);
};

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
