import type * as bun from "bun:test";

// What `bun test` defines in a suite that imports no value from "bun:test"; bun-types leaves `jest.mock` untyped.
declare global {
    var describe: typeof bun.describe;
    var it: typeof bun.it;
    var test: typeof bun.test;
    var expect: typeof bun.expect;
    var expectTypeOf: typeof bun.expectTypeOf;
    var beforeAll: typeof bun.beforeAll;
    var beforeEach: typeof bun.beforeEach;
    var afterAll: typeof bun.afterAll;
    var afterEach: typeof bun.afterEach;
    var jest: typeof bun.jest & { mock: typeof bun.mock.module };
}
