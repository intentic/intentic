//! Minimal MP4 writer for recordings (voxl's): the H.264 castd already sends, rewrapped without
//! re-encoding. Frames arrive only when the screen changes, so each sample lasts until
//! the next one (variable frame rate).

/// One encoded frame: time since the recording started (ms), keyframe, Annex-B data.
pub struct Frame {
    pub ms: u64,
    pub key: bool,
    pub data: bytes::Bytes,
}

const TIMESCALE: u32 = 1000;

/// NAL units of an Annex-B stream (start codes removed).
pub fn nals(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if let Some(s) = start {
                // A 4-byte start code leaves a zero at the end of the previous unit.
                let mut end = i;
                while end > s && data[end - 1] == 0 {
                    end -= 1;
                }
                out.push(&data[s..end]);
            }
            i += 3;
            start = Some(i);
        } else {
            i += 1;
        }
    }
    if let Some(s) = start {
        out.push(&data[s..]);
    }
    out.into_iter().filter(|n| !n.is_empty()).collect()
}

fn bx(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&(body.len() as u32 + 8).to_be_bytes());
    v.extend_from_slice(name);
    v.extend_from_slice(body);
    v
}

/// A full box: version 0 and `flags`, then the body.
fn fbx(name: &[u8; 4], flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = flags.to_be_bytes().to_vec();
    b.extend_from_slice(body);
    bx(name, &b)
}

fn u32s(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_be_bytes()).collect()
}

/// Identity transformation matrix of movie and track headers.
const MATRIX: [u32; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];

/// One sample of the track as moov describes it: when it starts, whether a decoder can start there, and its size in
/// mdat (its NAL units, each behind a 4-byte length).
pub struct Sample {
    pub ms: u64,
    pub key: bool,
    pub size: u32,
}

/// An access unit's NAL units as an MP4 sample keeps them (parameter sets and delimiters left out), and the SPS and PPS
/// it carries, if any.
struct Unit<'a> {
    units: Vec<&'a [u8]>,
    sps: Option<&'a [u8]>,
    pps: Option<&'a [u8]>,
}

fn unit_of(data: &[u8]) -> Unit<'_> {
    let (mut sps, mut pps, mut units) = (None, None, Vec::new());
    for n in nals(data) {
        match n[0] & 0x1f {
            7 => sps = sps.or(Some(n)),
            8 => pps = pps.or(Some(n)),
            9 => {}
            _ => units.push(n),
        }
    }
    Unit { units, sps, pps }
}

impl Unit<'_> {
    fn size(&self) -> u32 {
        self.units.iter().map(|n| n.len() as u32 + 4).sum()
    }

    fn write_to(&self, out: &mut impl std::io::Write) -> std::io::Result<()> {
        for n in &self.units {
            out.write_all(&(n.len() as u32).to_be_bytes())?;
            out.write_all(n)?;
        }
        Ok(())
    }
}

/// The moov box for `samples` (the first a keyframe), with its one chunk offset at `chunk_offset`: where mdat's
/// payload starts in the file.
fn moov(
    samples: &[Sample],
    sps: &[u8],
    pps: &[u8],
    width: u32,
    height: u32,
    end_ms: u64,
    chunk_offset: u32,
) -> Result<Vec<u8>, String> {
    if sps.len() < 4 {
        return Err("bad SPS".into());
    }
    let n = samples.len() as u32;
    let mut sizes = Vec::with_capacity(samples.len());
    let mut durations = Vec::with_capacity(samples.len());
    let mut sync = Vec::new();
    for (i, f) in samples.iter().enumerate() {
        sizes.push(f.size);
        let next = samples
            .get(i + 1)
            .map(|n| n.ms)
            .unwrap_or(end_ms.max(f.ms + 17));
        durations.push(next.saturating_sub(f.ms).max(1) as u32);
        if f.key {
            sync.push(i as u32 + 1);
        }
    }
    let total: u64 = durations.iter().map(|&d| d as u64).sum();

    let mut avcc = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(sps);
    avcc.push(1);
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(pps);
    if matches!(sps[1], 100 | 110 | 122 | 144) {
        // 4:2:0, 8-bit, no SPS extensions.
        avcc.extend_from_slice(&[0xfd, 0xf8, 0xf8, 0]);
    }
    let mut avc1 = vec![0u8; 6];
    avc1.extend_from_slice(&1u16.to_be_bytes()); // data reference index
    avc1.extend_from_slice(&[0u8; 16]);
    avc1.extend_from_slice(&(width as u16).to_be_bytes());
    avc1.extend_from_slice(&(height as u16).to_be_bytes());
    avc1.extend_from_slice(&u32s(&[0x48_0000, 0x48_0000, 0]));
    avc1.extend_from_slice(&1u16.to_be_bytes()); // frame count
    avc1.extend_from_slice(&[0u8; 32]); // compressor name
    avc1.extend_from_slice(&[0, 0x18, 0xff, 0xff]); // depth, pre-defined
    avc1.extend_from_slice(&bx(b"avcC", &avcc));
    let stsd = fbx(b"stsd", 0, &[u32s(&[1]), bx(b"avc1", &avc1)].concat());

    // Runs of equal durations.
    let mut stts: Vec<(u32, u32)> = Vec::new();
    for &d in &durations {
        match stts.last_mut() {
            Some((c, last)) if *last == d => *c += 1,
            _ => stts.push((1, d)),
        }
    }
    let stts = fbx(
        b"stts",
        0,
        &[
            u32s(&[stts.len() as u32]),
            stts.iter().flat_map(|&(c, d)| u32s(&[c, d])).collect(),
        ]
        .concat(),
    );
    let stss = fbx(
        b"stss",
        0,
        &[u32s(&[sync.len() as u32]), u32s(&sync)].concat(),
    );
    let stsz = fbx(b"stsz", 0, &[u32s(&[0, n]), u32s(&sizes)].concat());
    let stsc = fbx(b"stsc", 0, &u32s(&[1, 1, n, 1]));
    let stco = fbx(b"stco", 0, &u32s(&[1, chunk_offset]));
    let stbl = bx(b"stbl", &[stsd, stts, stss, stsz, stsc, stco].concat());

    let dinf = bx(
        b"dinf",
        &fbx(b"dref", 0, &[u32s(&[1]), fbx(b"url ", 1, &[])].concat()),
    );
    let vmhd = fbx(b"vmhd", 1, &[0u8; 8]);
    let minf = bx(b"minf", &[vmhd, dinf, stbl].concat());
    let mut hdlr = u32s(&[0]);
    hdlr.extend_from_slice(b"vide");
    hdlr.extend_from_slice(&[0u8; 12]);
    hdlr.extend_from_slice(b"castd\0");
    let hdlr = fbx(b"hdlr", 0, &hdlr);
    let mut mdhd = u32s(&[0, 0, TIMESCALE, total as u32]);
    mdhd.extend_from_slice(&[0x55, 0xc4, 0, 0]); // language "und"
    let mdia = bx(b"mdia", &[fbx(b"mdhd", 0, &mdhd), hdlr, minf].concat());

    let mut tkhd = u32s(&[0, 0, 1, 0, total as u32, 0, 0]);
    tkhd.extend_from_slice(&[0u8; 4]); // layer, alternate group
    tkhd.extend_from_slice(&[0u8; 4]); // volume, reserved
    tkhd.extend_from_slice(&u32s(&MATRIX));
    tkhd.extend_from_slice(&u32s(&[width << 16, height << 16]));
    let trak = bx(b"trak", &[fbx(b"tkhd", 3, &tkhd), mdia].concat());

    let mut mvhd = u32s(&[0, 0, TIMESCALE, total as u32, 0x10000]);
    mvhd.extend_from_slice(&[1, 0, 0, 0]); // volume 1.0, reserved
    mvhd.extend_from_slice(&[0u8; 8]);
    mvhd.extend_from_slice(&u32s(&MATRIX));
    mvhd.extend_from_slice(&[0u8; 24]); // pre-defined
    mvhd.extend_from_slice(&u32s(&[2])); // next track id
    Ok(bx(b"moov", &[fbx(b"mvhd", 0, &mvhd), trak].concat()))
}

const FTYP: &[u8] = b"isom\0\0\x02\0isomiso2avc1mp41";

/// Writes `frames` (the first must be a keyframe) as an MP4 of `width`x`height`
/// lasting until `end_ms`.
pub fn write(frames: &[Frame], width: u32, height: u32, end_ms: u64) -> Result<Vec<u8>, String> {
    let first = frames.first().ok_or("no frames were recorded")?;
    if !first.key {
        return Err("recording doesn't start with a keyframe".into());
    }
    let head = unit_of(&first.data);
    let (sps, pps) = (
        head.sps.ok_or("keyframe without SPS")?.to_vec(),
        head.pps.ok_or("keyframe without PPS")?.to_vec(),
    );
    // Samples: length-prefixed NAL units, parameter sets and delimiters left out. They
    // are only sized here and copied once, straight into the output, at the end.
    let units: Vec<Unit> = frames.iter().map(|f| unit_of(&f.data)).collect();
    let samples: Vec<Sample> = frames
        .iter()
        .zip(&units)
        .map(|(f, u)| Sample {
            ms: f.ms,
            key: f.key,
            size: u.size(),
        })
        .collect();
    let mdat_len: u64 = samples.iter().map(|s| s.size as u64).sum();
    if mdat_len + 8 > u32::MAX as u64 {
        return Err("recording too large".into());
    }
    let ftyp = bx(b"ftyp", FTYP);
    // moov goes first, so a player can start before the whole file has arrived. Its size does not depend on the chunk
    // offset, so it is sized with none: the samples start right after ftyp, moov and mdat's header.
    let probe = moov(&samples, &sps, &pps, width, height, end_ms, 0)?;
    let offset = (ftyp.len() + probe.len() + 8) as u32;
    let moov = moov(&samples, &sps, &pps, width, height, end_ms, offset)?;
    let mut out = Vec::with_capacity(offset as usize + mdat_len as usize);
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&moov);
    out.extend_from_slice(&(mdat_len as u32 + 8).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for u in &units {
        u.write_to(&mut out).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// An MP4 written as it is recorded: ftyp, then mdat (its size patched at the end), then moov once the samples are
/// known. Only each sample's size and time are kept in memory, never a picture.
pub struct Streaming<W: std::io::Write + std::io::Seek> {
    out: W,
    params: Option<(Vec<u8>, Vec<u8>)>,
    samples: Vec<Sample>,
    // Where mdat's 16-byte header (a 64-bit size) starts, and how much payload follows it.
    mdat_at: u64,
    written: u64,
}

impl<W: std::io::Write + std::io::Seek> Streaming<W> {
    pub fn new(mut out: W) -> std::io::Result<Self> {
        let ftyp = bx(b"ftyp", FTYP);
        out.write_all(&ftyp)?;
        // `size` 1: the size is the 64-bit field after the type, patched by `finish`.
        out.write_all(&1u32.to_be_bytes())?;
        out.write_all(b"mdat")?;
        out.write_all(&0u64.to_be_bytes())?;
        Ok(Streaming {
            out,
            params: None,
            samples: Vec::new(),
            mdat_at: ftyp.len() as u64,
            written: 0,
        })
    }

    /// Whether no sample has been written yet.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Frames before the first keyframe that carries SPS and PPS are skipped: nothing could decode them.
    pub fn push(&mut self, ms: u64, key: bool, data: &[u8]) -> Result<(), String> {
        let unit = unit_of(data);
        if self.params.is_none() {
            match (key, unit.sps, unit.pps) {
                (true, Some(sps), Some(pps)) => self.params = Some((sps.to_vec(), pps.to_vec())),
                _ => return Ok(()),
            }
        }
        let ms = self.samples.last().map_or(ms, |l| ms.max(l.ms + 1));
        let size = unit.size();
        unit.write_to(&mut self.out).map_err(|e| e.to_string())?;
        self.written += u64::from(size);
        self.samples.push(Sample { ms, key, size });
        Ok(())
    }

    /// Writes moov after the samples and mdat's size; answers the writer and the file's length.
    pub fn finish(mut self, width: u32, height: u32, end_ms: u64) -> Result<(W, u64), String> {
        let Some((sps, pps)) = self.params.take() else {
            return Err("no frames were recorded".into());
        };
        let payload_at = u32::try_from(self.mdat_at + 16).map_err(|_| "ftyp too large")?;
        let moov = moov(&self.samples, &sps, &pps, width, height, end_ms, payload_at)?;
        let io = |e: std::io::Error| e.to_string();
        self.out.write_all(&moov).map_err(io)?;
        self.out
            .seek(std::io::SeekFrom::Start(self.mdat_at + 8))
            .map_err(io)?;
        self.out
            .write_all(&(16 + self.written).to_be_bytes())
            .map_err(io)?;
        self.out.flush().map_err(io)?;
        let len = self.mdat_at + 16 + self.written + moov.len() as u64;
        Ok((self.out, len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_annex_b() {
        let d = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5,
        ];
        let n = nals(&d);
        assert_eq!(
            n,
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]
        );
    }

    #[test]
    fn a_streamed_recording_has_the_same_samples_as_one_written_whole() {
        let key = bytes::Bytes::from_static(&[
            0, 0, 0, 1, 0x67, 100, 0, 40, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0xaa,
        ]);
        let delta = bytes::Bytes::from_static(&[0, 0, 0, 1, 0x41, 0xbb, 0xcc]);
        let mut streamed = Streaming::new(std::io::Cursor::new(Vec::new())).unwrap();
        // A delta before any keyframe is nothing a decoder could start on.
        streamed.push(0, false, &delta).unwrap();
        streamed.push(0, true, &key).unwrap();
        streamed.push(40, false, &delta).unwrap();
        let (out, len) = streamed.finish(64, 32, 100).unwrap();
        let out = out.into_inner();
        assert_eq!(len as usize, out.len());
        let pos = |t: &[u8]| out.windows(4).position(|w| w == t).unwrap();
        // mdat first, its 64-bit size spanning its header and both samples, then moov.
        let mdat = pos(b"mdat");
        assert!(mdat < pos(b"moov"));
        assert_eq!(
            u32::from_be_bytes(out[mdat - 4..mdat].try_into().unwrap()),
            1
        );
        assert_eq!(
            u64::from_be_bytes(out[mdat + 4..mdat + 12].try_into().unwrap()),
            16 + 13
        );
        let stco = pos(b"stco");
        let off = u32::from_be_bytes(out[stco + 12..stco + 16].try_into().unwrap()) as usize;
        assert_eq!(off, mdat + 12);
        assert_eq!(
            &out[off..off + 13],
            &[0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 3, 0x41, 0xbb, 0xcc]
        );
        // The same samples, timed alike, as the whole recording would have.
        let whole = write(
            &[
                Frame {
                    ms: 0,
                    key: true,
                    data: key,
                },
                Frame {
                    ms: 40,
                    key: false,
                    data: delta,
                },
            ],
            64,
            32,
            100,
        )
        .unwrap();
        let tables = |o: &[u8]| {
            let at = o.windows(4).position(|w| w == b"stts").unwrap();
            o[at..at + 24].to_vec()
        };
        assert_eq!(tables(&out), tables(&whole));
    }

    #[test]
    fn a_streamed_recording_with_no_keyframe_is_none() {
        let delta = [0u8, 0, 0, 1, 0x41, 0xbb];
        let mut streamed = Streaming::new(std::io::Cursor::new(Vec::new())).unwrap();
        streamed.push(0, false, &delta).unwrap();
        assert!(streamed.finish(64, 32, 100).is_err());
    }

    #[test]
    fn moov_first_and_chunk_offset_points_at_the_samples() {
        let key = bytes::Bytes::from_static(&[
            0, 0, 0, 1, 0x67, 100, 0, 40, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0xaa,
        ]);
        let delta = bytes::Bytes::from_static(&[0, 0, 0, 1, 0x41, 0xbb, 0xcc]);
        let frames = [
            Frame {
                ms: 0,
                key: true,
                data: key,
            },
            Frame {
                ms: 40,
                key: false,
                data: delta,
            },
        ];
        let out = write(&frames, 64, 32, 100).unwrap();
        let pos = |t: &[u8]| out.windows(4).position(|w| w == t).unwrap();
        assert!(pos(b"moov") < pos(b"mdat"));
        let stco = pos(b"stco");
        let off = u32::from_be_bytes(out[stco + 12..stco + 16].try_into().unwrap()) as usize;
        assert_eq!(off, pos(b"mdat") + 4);
        // Both samples, length-prefixed, parameter sets left out.
        assert_eq!(
            &out[off..],
            &[0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 3, 0x41, 0xbb, 0xcc]
        );
    }
}
