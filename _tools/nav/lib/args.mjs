/* THE ONE FLAG READER FOR THIS HARNESS'S SCRIPTS.
 *
 * Every entry point here is run by hand or by CI with a handful of `--name value` flags, and each one had
 * written the same four lines to read them. Not `node:util`'s parseArgs: that wants a declared option table
 * per script, which is more ceremony than three flags deserve, and it throws on unknown flags — these scripts
 * are routinely run with extra flags a wrapper passed through.
 *
 * A flag named at the very END of argv with no value after it reads as absent rather than swallowing the
 * following `undefined`, so `--since` typed alone falls back instead of comparing against the string
 * "undefined".
 */
export const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
};
