//! SPA PODs, the typed values PipeWire negotiates formats and buffers in, built and read by hand: libspa's own
//! builders are inline functions in its headers, which a library opened at run time does not have. The layout is
//! spa/pod/pod.h's: a POD is its body's size and its type (two u32), then the body, padded to 8 bytes; an object's body
//! is its type and id, then properties (key, flags, a POD each); a choice's is its kind and flags, then one child header
//! and the values packed after it.

/// spa/utils/type.h
pub const TYPE_ID: u32 = 3;
pub const TYPE_INT: u32 = 4;
pub const TYPE_LONG: u32 = 5;
pub const TYPE_RECTANGLE: u32 = 10;
pub const TYPE_FRACTION: u32 = 11;
pub const TYPE_OBJECT: u32 = 15;
pub const TYPE_CHOICE: u32 = 19;
pub const OBJECT_FORMAT: u32 = 0x40003;
pub const OBJECT_PARAM_BUFFERS: u32 = 0x40004;
pub const OBJECT_PARAM_META: u32 = 0x40005;

/// spa/param/param.h
pub const PARAM_ENUM_FORMAT: u32 = 3;
pub const PARAM_FORMAT: u32 = 4;
pub const PARAM_BUFFERS: u32 = 5;
pub const PARAM_META: u32 = 6;

/// spa/param/format.h
pub const FORMAT_MEDIA_TYPE: u32 = 1;
pub const FORMAT_MEDIA_SUBTYPE: u32 = 2;
pub const FORMAT_VIDEO_FORMAT: u32 = 0x20001;
pub const FORMAT_VIDEO_MODIFIER: u32 = 0x20002;
pub const FORMAT_VIDEO_SIZE: u32 = 0x20003;
pub const FORMAT_VIDEO_FRAMERATE: u32 = 0x20004;
pub const MEDIA_TYPE_VIDEO: u32 = 2;
pub const MEDIA_SUBTYPE_RAW: u32 = 1;

/// spa/param/video/raw.h
pub const VIDEO_FORMAT_RGBX: u32 = 7;
pub const VIDEO_FORMAT_BGRX: u32 = 8;
pub const VIDEO_FORMAT_XRGB: u32 = 9;
pub const VIDEO_FORMAT_XBGR: u32 = 10;
pub const VIDEO_FORMAT_RGBA: u32 = 11;
pub const VIDEO_FORMAT_BGRA: u32 = 12;
pub const VIDEO_FORMAT_ARGB: u32 = 13;
pub const VIDEO_FORMAT_ABGR: u32 = 14;

/// spa/param/buffers.h
pub const BUFFERS_BUFFERS: u32 = 1;
pub const BUFFERS_BLOCKS: u32 = 2;
pub const BUFFERS_SIZE: u32 = 3;
pub const BUFFERS_STRIDE: u32 = 4;
pub const BUFFERS_DATA_TYPE: u32 = 6;
pub const META_TYPE: u32 = 1;
pub const META_SIZE: u32 = 2;

/// spa/buffer/meta.h and buffer.h
pub const META_HEADER: u32 = 1;
pub const META_VIDEO_DAMAGE: u32 = 3;
pub const META_CURSOR: u32 = 5;
pub const DATA_MEM_PTR: u32 = 1;
pub const DATA_MEM_FD: u32 = 2;
pub const DATA_DMA_BUF: u32 = 3;

pub const CHOICE_NONE: u32 = 0;
pub const CHOICE_RANGE: u32 = 1;
pub const CHOICE_ENUM: u32 = 3;
pub const CHOICE_FLAGS: u32 = 4;

/// One POD, built into bytes.
#[derive(Default)]
pub struct Builder {
    pub bytes: Vec<u8>,
}

fn pad(v: &mut Vec<u8>) {
    while !v.len().is_multiple_of(8) {
        v.push(0);
    }
}

/// A value's type and body (unpadded).
#[derive(Clone)]
pub enum Value {
    Id(u32),
    Int(i32),
    Long(i64),
    Rect(u32, u32),
    Fraction(u32, u32),
    /// A choice of `kind` over values of one type, the default first.
    Choice(u32, Vec<Value>),
}

impl Value {
    fn kind(&self) -> u32 {
        match self {
            Value::Id(_) => TYPE_ID,
            Value::Int(_) => TYPE_INT,
            Value::Long(_) => TYPE_LONG,
            Value::Rect(..) => TYPE_RECTANGLE,
            Value::Fraction(..) => TYPE_FRACTION,
            Value::Choice(..) => TYPE_CHOICE,
        }
    }

    fn body(&self) -> Vec<u8> {
        match self {
            Value::Id(v) => v.to_ne_bytes().to_vec(),
            Value::Int(v) => v.to_ne_bytes().to_vec(),
            Value::Long(v) => v.to_ne_bytes().to_vec(),
            Value::Rect(a, b) | Value::Fraction(a, b) => {
                [a.to_ne_bytes(), b.to_ne_bytes()].concat()
            }
            Value::Choice(kind, values) => {
                let child = values.first().map(Value::kind).unwrap_or(TYPE_INT);
                let size = values.first().map_or(0, |v| v.body().len()) as u32;
                let mut out = Vec::new();
                out.extend_from_slice(&kind.to_ne_bytes());
                out.extend_from_slice(&0u32.to_ne_bytes());
                out.extend_from_slice(&size.to_ne_bytes());
                out.extend_from_slice(&child.to_ne_bytes());
                for v in values {
                    out.extend_from_slice(&v.body());
                }
                out
            }
        }
    }

    fn write(&self, out: &mut Vec<u8>) {
        let body = self.body();
        out.extend_from_slice(&(body.len() as u32).to_ne_bytes());
        out.extend_from_slice(&self.kind().to_ne_bytes());
        out.extend_from_slice(&body);
        pad(out);
    }
}

/// An object POD: `(key, flags, value)` properties.
pub fn object(object_type: u32, id: u32, props: &[(u32, u32, Value)]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&object_type.to_ne_bytes());
    body.extend_from_slice(&id.to_ne_bytes());
    for (key, flags, value) in props {
        body.extend_from_slice(&key.to_ne_bytes());
        body.extend_from_slice(&flags.to_ne_bytes());
        value.write(&mut body);
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&(body.len() as u32).to_ne_bytes());
    out.extend_from_slice(&TYPE_OBJECT.to_ne_bytes());
    out.extend_from_slice(&body);
    pad(&mut out);
    out
}

/// A property's value as read: the type and the body of the value itself, or of a choice's first (default) value.
pub struct Read<'a> {
    pub kind: u32,
    pub body: &'a [u8],
}

impl Read<'_> {
    pub fn u32(&self) -> Option<u32> {
        Some(u32::from_ne_bytes(self.body.get(..4)?.try_into().ok()?))
    }
    pub fn i64(&self) -> Option<i64> {
        Some(i64::from_ne_bytes(self.body.get(..8)?.try_into().ok()?))
    }
    pub fn pair(&self) -> Option<(u32, u32)> {
        Some((
            u32::from_ne_bytes(self.body.get(..4)?.try_into().ok()?),
            u32::from_ne_bytes(self.body.get(4..8)?.try_into().ok()?),
        ))
    }
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The properties of an object POD (`pod` is the whole POD, header first): `(key, value)`, a choice read as its
/// default.
pub fn properties(pod: &[u8]) -> Vec<(u32, Read<'_>)> {
    let mut out = Vec::new();
    let (Some(size), Some(kind)) = (u32_at(pod, 0), u32_at(pod, 4)) else {
        return out;
    };
    if kind != TYPE_OBJECT {
        return out;
    }
    let end = (8 + size as usize).min(pod.len());
    let mut at = 16; // the header, then the object's type and id
    while at + 16 <= end {
        let key = u32_at(pod, at).unwrap_or(0);
        let vsize = u32_at(pod, at + 8).unwrap_or(0) as usize;
        let vtype = u32_at(pod, at + 12).unwrap_or(0);
        let body_at = at + 16;
        let Some(body) = pod.get(body_at..body_at + vsize) else {
            break;
        };
        let read = if vtype == TYPE_CHOICE && body.len() >= 16 {
            let child_size = u32_at(body, 8).unwrap_or(0) as usize;
            let child_type = u32_at(body, 12).unwrap_or(0);
            Read {
                kind: child_type,
                body: body.get(16..16 + child_size).unwrap_or(&[]),
            }
        } else {
            Read { kind: vtype, body }
        };
        out.push((key, read));
        at = body_at + vsize.div_ceil(8) * 8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_object_reads_back_with_choices_as_their_default() {
        let pod = object(
            OBJECT_FORMAT,
            PARAM_ENUM_FORMAT,
            &[
                (FORMAT_MEDIA_TYPE, 0, Value::Id(MEDIA_TYPE_VIDEO)),
                (
                    FORMAT_VIDEO_FORMAT,
                    0,
                    Value::Choice(
                        CHOICE_ENUM,
                        vec![
                            Value::Id(VIDEO_FORMAT_BGRX),
                            Value::Id(VIDEO_FORMAT_BGRX),
                            Value::Id(VIDEO_FORMAT_RGBX),
                        ],
                    ),
                ),
                (
                    FORMAT_VIDEO_SIZE,
                    0,
                    Value::Choice(
                        CHOICE_RANGE,
                        vec![
                            Value::Rect(1920, 1080),
                            Value::Rect(1, 1),
                            Value::Rect(8192, 8192),
                        ],
                    ),
                ),
                (FORMAT_VIDEO_MODIFIER, 0, Value::Long(-1)),
            ],
        );
        assert_eq!(pod.len() % 8, 0);
        assert_eq!(
            u32::from_ne_bytes(pod[0..4].try_into().unwrap()) as usize,
            pod.len() - 8
        );
        let props = properties(&pod);
        assert_eq!(props.len(), 4);
        assert_eq!(
            (props[0].0, props[0].1.u32()),
            (FORMAT_MEDIA_TYPE, Some(MEDIA_TYPE_VIDEO))
        );
        assert_eq!(
            (props[1].1.kind, props[1].1.u32()),
            (TYPE_ID, Some(VIDEO_FORMAT_BGRX))
        );
        assert_eq!(props[2].1.pair(), Some((1920, 1080)));
        assert_eq!(props[3].1.i64(), Some(-1));
    }

    #[test]
    fn an_id_pod_is_padded_to_eight_bytes() {
        let mut out = Vec::new();
        Value::Id(2).write(&mut out);
        assert_eq!(out, [4, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
        let mut out = Vec::new();
        Value::Choice(CHOICE_FLAGS, vec![Value::Int(6)]).write(&mut out);
        // size 20 (kind, flags, child header, one int), type Choice, then 4 bytes of padding.
        assert_eq!(&out[..8], &[20, 0, 0, 0, 19, 0, 0, 0]);
        assert_eq!(out.len(), 32);
    }
}
