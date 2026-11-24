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
// 2026-11-24: each line's template and its "folds at all" check (IMPORTANT, unchanged by redaction) are worked out once
// and kept by index, and a run's constant fields are found in one pass over it. This replaced templating a line two or
// three times, redacting the line that ends a run twice, and re-templating the whole run once per field
// (O(fields × run)): this stage on a 50k-line single-template log 1.20 s → 0.19 s, on a mixed build log 394 → 171 ms
// (redaction's gates included). The checks are pure, so computing each once changes no outcome.
export const foldLogTemplates = (lines, values, redactText) => {
    const templates = [];
    const templateAt = (index) => (templates[index] ??= templateOf(lines[index]));
    const foldable = [];
    const foldableAt = (index) => (foldable[index] ??= !IMPORTANT.test(lines[index]) && redactText(lines[index], values) === lines[index]);
    const out = [];
    for (let start = 0; start < lines.length;) {
        const first = templateAt(start);
        let end = start + 1;
        if (
            foldableAt(start) &&
            first.fields.length > 0 &&
            (first.template.match(/(?:^|\s)[a-z]{3,}(?=\s|$)/gi) ?? []).length >= 2
        ) {
            while (end < lines.length && !IMPORTANT.test(lines[end]) && templateAt(end).template === first.template && foldableAt(end)) {
                end++;
            }
        }
        const length = end - start;
        if (length < 4) {
            // Too short to fold, whatever the fields do. A field missing from a later line (a line holding a literal
            // `<*>` templates alike with one field fewer) used to throw while describing a run of two or three, and
            // the filter answered with the raw text; kept, so the output stays the same.
            if (length > 1) {
                describeVarying(first.fields, start, end, templateAt);
            }
            for (let index = start; index < end; index++) {
                out.push(lines[index]);
            }
            start = end;
            continue;
        }
        const run = lines.slice(start, end);
        const varying = describeVarying(first.fields, start, end, templateAt);
        const folded = [run[0], `… ${run.length - 1} more lines like this (varying: ${varying.join(", ") || "none"})`];
        out.push(...(bodyBytes(folded) < bodyBytes(run) ? folded : run));
        start = end;
    }
    return out;
};

// `first..last` for every field of the run's first line that is not the same on every line, in field order.
const describeVarying = (firstFields, start, end, templateAt) => {
    const varies = firstFields.map(() => false);
    for (let index = start + 1; index < end; index++) {
        const fields = templateAt(index).fields;
        for (let field = 0; field < firstFields.length; field++) {
            varies[field] ||= fields[field] !== firstFields[field];
        }
    }
    const last = templateAt(end - 1).fields;
    return firstFields.flatMap((value, index) => (varies[index] ? [`${value.slice(0, 60)}..${last[index].slice(0, 60)}`] : []));
};
