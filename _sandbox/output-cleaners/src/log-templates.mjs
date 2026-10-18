// Consecutive log-template folding; the caller supplies the shared secret redactor.
import { bodyBytes, IMPORTANT } from "./cleaner-shapes.mjs";

const VARIABLE =
    /\d{4}-\d\d-\d\dT[\d:.]+Z?|[0-9a-f]{8}-[0-9a-f-]{27,}|0x[0-9a-f]+|\b[0-9a-f]{12,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|"[^"\n]*"|'[^'\n]*'|\d+(?:\.\d+)?(?:ms|us|ns|s|m|h)?/gi;
const templateOf = (line) => {
    const fields = [];
    const template = line.replace(VARIABLE, (value) => {
        fields.push(value);
        return "<*>";
    });
    return { template, fields };
};

// Four observations avoid treating a pair of unrelated events as a trend. A fold must also pay for its summary.
export const foldLogTemplates = (lines, values, redactText) => {
    const out = [];
    for (let start = 0; start < lines.length;) {
        const first = templateOf(lines[start]);
        let end = start + 1;
        if (
            !IMPORTANT.test(lines[start]) &&
            redactText(lines[start], values) === lines[start] &&
            first.fields.length > 0 &&
            (first.template.match(/(?:^|\s)[a-z]{3,}(?=\s|$)/gi) ?? []).length >= 2
        ) {
            while (
                end < lines.length &&
                !IMPORTANT.test(lines[end]) &&
                templateOf(lines[end]).template === first.template &&
                redactText(lines[end], values) === lines[end]
            ) {
                end++;
            }
        }
        const run = lines.slice(start, end);
        const last = templateOf(run.at(-1));
        const varying = first.fields.flatMap((value, index) =>
            value === last.fields[index] && run.every((line) => templateOf(line).fields[index] === value)
                ? []
                : [`${value.slice(0, 60)}..${last.fields[index].slice(0, 60)}`],
        );
        const folded = [run[0], `… ${run.length - 1} more lines like this (varying: ${varying.join(", ") || "none"})`];
        out.push(...(run.length >= 4 && bodyBytes(folded) < bodyBytes(run) ? folded : run));
        start = end;
    }
    return out;
};
