// The sound's decoder in the decode worker, on a fake AudioDecoder: built at the first packet once the audio thread's
// port is there, rebuilt after a packet it refused, and given up on for the stream when the browser cannot decode
// castd's codec at all.
import type { AudioDecoderLike } from "./decodeSeams";
import { soundDecode } from "./soundDecode";

class FakeDecoder implements AudioDecoderLike {
    state: CodecState = `unconfigured`;
    constructor(readonly init: AudioDecoderInit) {}
    configure(): void {
        this.state = `configured`;
    }
    decode(): void {}
    close(): void {
        this.state = `closed`;
    }
}

class FakeChunk implements EncodedAudioChunk {
    readonly byteLength = 0;
    readonly duration = null;
    readonly timestamp: number;
    readonly type: EncodedAudioChunkType;
    constructor(init: EncodedAudioChunkInit) {
        this.timestamp = init.timestamp;
        this.type = init.type;
    }
    copyTo(): void {}
}

const harness = () => {
    const built: { readonly init: AudioDecoderInit; readonly decoder: FakeDecoder }[] = [];
    const sound = soundDecode({
        audioDecoder: (init) => {
            const decoder = new FakeDecoder(init);
            built.push({ init, decoder });
            return decoder;
        },
        audioChunk: (init) => new FakeChunk(init),
    });
    sound.start({ codec: `opus`, sampleRate: 48_000, channels: 2 });
    sound.port(new MessageChannel().port1);
    return { sound, built };
};

it("builds a decoder at the first packet, and another after one that failed decoding", () => {
    const { sound, built } = harness();
    sound.push(new Uint8Array([1]));
    sound.push(new Uint8Array([2]));
    expect(built).toHaveLength(1);
    built[0]!.decoder.state = `closed`;
    built[0]!.init.error(new DOMException(`bad packet`, `EncodingError`));
    sound.push(new Uint8Array([3]));
    expect(built).toHaveLength(2);
});

it("builds no decoder after one the browser refused castd's codec for, until the next stream", () => {
    const { sound, built } = harness();
    sound.push(new Uint8Array([1]));
    built[0]!.decoder.state = `closed`;
    built[0]!.init.error(new DOMException(`Unsupported configuration`, `NotSupportedError`));
    // Fifty packets a second would otherwise build fifty decoders a second, each refused the same way.
    for (let packet = 0; packet < 50; packet += 1) {
        sound.push(new Uint8Array([packet]));
    }
    expect(built).toHaveLength(1);
    sound.start({ codec: `opus`, sampleRate: 48_000, channels: 2 });
    sound.push(new Uint8Array([1]));
    expect(built).toHaveLength(2);
});
