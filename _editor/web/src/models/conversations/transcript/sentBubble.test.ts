// The bubble a send draws before the daemon's row arrives says what that row will (turn-transcript.ts openingRows).
import { sentBubble } from "./transcript";

it(`carries the files and the file being looked at, without the selected text`, () => {
    const context = { file: `src/app.ts`, startLine: 3, endLine: 4, selection: `const a = 1;\nconst b = 2;` };
    expect(sentBubble(`fix this`, [{ name: `shot.png`, path: `x/shot.png` }], context)).toEqual({
        role: `user`,
        text: `fix this`,
        attachments: [`x/shot.png`],
        editorContext: { file: `src/app.ts`, startLine: 3, endLine: 4 },
    });
});

it(`is the words alone when nothing came with them`, () => {
    expect(sentBubble(`go`, [])).toEqual({ role: `user`, text: `go` });
});
