import { ensureDiscordClient } from "./client.js";

// A login discord.js refuses is told by its error code, not its sentence: an empty token is refused before any request.
test("a token discord.js refuses is reported as the bot token to fix", async () => {
    await expect(ensureDiscordClient("", "listener")).rejects.toThrow("Discord rejected the bot token: check the capability's botToken");
});
