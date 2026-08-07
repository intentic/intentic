import semanticRelease from "semantic-release";

/* Compute the version before an artifact is built. Dry-run skips prepare/publish/success, while running the
 * same analyzer and branch/tag discovery the publishing invocation will use. Its logs go to stderr so stdout
 * is valid GitHub job-output syntax even when there is no release. */
const result = await semanticRelease(
    { dryRun: true },
    {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stderr,
        stderr: process.stderr,
    },
);

process.stdout.write(`version=${result === false ? `` : result.nextRelease.version}\n`);
