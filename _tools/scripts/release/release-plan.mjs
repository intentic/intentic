import semanticRelease from "semantic-release";

/* Compute the version before an artifact is built. */
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
