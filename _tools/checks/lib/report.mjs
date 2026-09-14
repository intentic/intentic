/* HOW A CHECK ANSWERS: sections of problems to stderr and exit 1, or one line per thing it vouched for to stdout and exit 0. */

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
