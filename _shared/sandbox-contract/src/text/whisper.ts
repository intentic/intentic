// Shared reading of whisper.cpp's stdout, used by the daemon's speech route and Discord's voice session, so both filter
// non-speech annotations the same way.

// Hugging Face repo the ggml-*.bin weights pull from on first use; each integration downloads its own size.
export const WHISPER_MODEL_REPO = "ggerganov/whisper.cpp";

// Cleans whisper's stdout to one line of text, or undefined for silence/noise-only output — a line that is entirely a
// bracketed annotation like `[BLANK_AUDIO]`.
export const cleanTranscription = (stdout: string): string | undefined => {
    const text = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !/^[[(].*[\])]$/.test(line))
        .join(" ")
        .trim();
    return text === "" ? undefined : text;
};
