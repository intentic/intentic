// What quote-splices.mjs reads a file for: a value spliced between bare quotes on a line that builds a command, in a
// file that does not import the shared quoters. Kept apart from the check so its suite can feed it text.

// The shape: a value interpolated between a matched pair of quote characters. `'${password}'`, `"${sql}"`.
const QUOTED_INTERPOLATION = /['"]\$\{[^{}]*\}['"]/;

// On a line building a command for something else to parse; the markers are strong so prose does not match.
const BUILDS_A_COMMAND = /\.exec\(|execSync|execFileSync|printf |docker |psql |valkey-cli|restic -r|sh -c|bash -c/;

// A line whose only content is prose.
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

/** Whether `text` imports the shared quoters, which is what lets it splice: the import is the promise it wraps each value. */
export const importsQuoters = (text) => /@intentic\/sandbox-run\/quote/.test(text);

/** Every hand-quoted splice into a command in `text`, as `{ line, code }`; none in a file that imports the quoters. */
export const quoteSplices = (text) =>
    importsQuoters(text)
        ? []
        : text
              .split("\n")
              .flatMap((code, index) =>
                  !COMMENT.test(code) && QUOTED_INTERPOLATION.test(code) && BUILDS_A_COMMAND.test(code) ? [{ line: index + 1, code: code.trim() }] : [],
              );
