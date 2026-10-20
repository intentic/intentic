//! Value types that read what a newer sandbox sends without failing the frame around them.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Declares a string enum that keeps a value it does not know as `Other(text)` rather than refusing the whole message,
/// and writes it back exactly as it came. The contract's enums grow freely (its shrink check only guards removals), so
/// a phone that has not updated meets new values routinely.
macro_rules! open_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $(#[$variant_meta:meta])* $variant:ident = $wire:literal, )+
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum $name {
            $( $(#[$variant_meta])* $variant, )+
            /// A value this build does not know, kept as it was sent.
            Other(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $( Self::$variant => $wire, )+
                    Self::Other(other) => other,
                }
            }
        }

        impl From<&str> for $name {
            fn from(text: &str) -> Self {
                match text {
                    $( $wire => Self::$variant, )+
                    other => Self::Other(other.to_owned()),
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                Ok(Self::from(text.as_str()))
            }
        }
    };
}
pub(crate) use open_enum;

/// Reads any JSON number as a whole one. The contract types instants and counters as `number`, so a fraction is legal
/// on the wire even where none is ever sent, and refusing one would drop the frame it rode in.
fn whole<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    number
        .as_i64()
        .or_else(|| number.as_f64().map(|float| float as i64))
        .ok_or_else(|| D::Error::custom("a number too large for 64 bits"))
}

/// An instant in epoch milliseconds, the unit almost every `…At` field on the wire uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Millis(pub i64);

/// An instant in epoch seconds: the few fields that carry a provider's own clock (a spent allowance's reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Secs(pub i64);

impl Secs {
    pub fn millis(self) -> Millis {
        Millis(self.0.saturating_mul(1_000))
    }
}

macro_rules! whole_number {
    ($name:ident) => {
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_i64(self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                whole(deserializer).map($name)
            }
        }
    };
}
whole_number!(Millis);
whole_number!(Secs);

/// A position in a run's frames or in a conversation's record: a count, read leniently like the instants above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Seq(pub u64);
impl Serialize for Seq {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(self.0)
    }
}
impl<'de> Deserialize<'de> for Seq {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        whole(deserializer).map(|value| Seq(value.max(0) as u64))
    }
}

/// A field the contract fixes to one value (`z.literal(true)`): present means true, and it is written back as `true`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct True;
impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}
impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match bool::deserialize(deserializer)? {
            true => Ok(True),
            false => Err(D::Error::custom("expected true")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    open_enum! {
        pub enum Colour {
            Red = "red",
        }
    }

    #[test]
    fn keeps_an_unknown_value_as_it_came() {
        let colour: Colour = serde_json::from_str(r#""ultraviolet""#).unwrap();
        assert_eq!(colour, Colour::Other("ultraviolet".into()));
        assert_eq!(serde_json::to_string(&colour).unwrap(), r#""ultraviolet""#);
        assert_eq!(
            serde_json::from_str::<Colour>(r#""red""#).unwrap(),
            Colour::Red
        );
    }

    #[test]
    fn reads_a_fractional_instant_as_a_whole_one() {
        assert_eq!(
            serde_json::from_str::<Millis>("1729000000000.7").unwrap(),
            Millis(1729000000000)
        );
        assert_eq!(serde_json::to_string(&Millis(5)).unwrap(), "5");
    }
}
