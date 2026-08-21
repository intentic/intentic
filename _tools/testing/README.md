# @intentic/testing

The test-support seams every package's suites share: deep, self-naming stand-ins for wide interfaces.

## Responsibilities

- Provide the fakes that stand in for wide interfaces, so a suite does not hand-roll a fifth one.
- Provide the shared vitest configuration and the e2e gate.

## Key files

- [src/index.ts](src/index.ts): the stand-ins.
- [src/vitest.ts](src/vitest.ts): shared configuration.
- [src/e2e.ts](src/e2e.ts): the opt-in gate `*.e2e.test.ts` suites sit behind.

## How it fits

Imported by suites across the monorepo. It ships no production code and nothing depends on it at runtime.

## Conventions & gotchas

- **Self-naming.** A stand-in reports what it is when an assertion fails, because the alternative: a bare
  `undefined is not a function` five frames deep: is how an afternoon disappears.
- Deep rather than shallow: it stands in for the whole interface, so a suite does not have to know which three
  methods the code under test happens to call today.
