import { foldersOverlap } from "./folders.js";

// One folder, one sync: the same folder, or one inside the other, is an overlap on every platform; case decides it only
// where the platform's own volumes ignore case.
describe("foldersOverlap", () => {
    it("is an overlap for the same folder, however it is spelled", () => {
        expect(foldersOverlap("/home/ada/code/app", "/home/ada/code/app", "linux")).toBe(true);
        expect(foldersOverlap("/home/ada/code/app/", "/home/ada/code/./app", "linux")).toBe(true);
    });

    it("is an overlap for a folder inside another, whichever of the two is asked about first", () => {
        expect(foldersOverlap("/home/ada/intentic/work/app", "/home/ada/intentic/work", "linux")).toBe(true);
        expect(foldersOverlap("/home/ada", "/home/ada/intentic/work", "linux")).toBe(true);
        // A child whose name starts with two dots is inside, not above: `..app` is no parent reference.
        expect(foldersOverlap("/home/ada/code/..app", "/home/ada/code", "linux")).toBe(true);
    });

    it("is no overlap for siblings, or for a sibling whose name merely starts the same", () => {
        expect(foldersOverlap("/home/ada/code/app", "/home/ada/code/api", "linux")).toBe(false);
        expect(foldersOverlap("/home/ada/code/app", "/home/ada/code/app-2", "linux")).toBe(false);
    });

    it("folds case on macOS and Windows and nowhere else", () => {
        expect(foldersOverlap("/Users/ada/Code/App", "/Users/ada/code/app", "darwin")).toBe(true);
        expect(foldersOverlap("/home/ada/Code/App", "/home/ada/code/app", "linux")).toBe(false);
        expect(foldersOverlap(String.raw`C:\Users\Ada\Code\App`, String.raw`c:\users\ada\code`, "win32")).toBe(true);
    });

    it("reads Windows paths with Windows separators, and different drives as different folders", () => {
        expect(foldersOverlap(String.raw`C:\Users\Ada\intentic\work`, "C:/Users/Ada/intentic/work/app", "win32")).toBe(true);
        expect(foldersOverlap(String.raw`D:\code\app`, String.raw`C:\code\app`, "win32")).toBe(false);
    });
});
