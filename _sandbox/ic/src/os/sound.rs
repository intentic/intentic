use std::time::Duration;

use serde_json::{json, Value};

use super::tool;
use crate::util::{bail, Result};

/* `ic os sound`: THE VOLUME, MUTE AND WHICH SPEAKER PLAYS. PipeWire carries the sound on Intentic OS and WirePlumber
manages it; `wpctl` is WirePlumber's own command line, and the pure functions below read what it prints (as
WirePlumber 0.5.18 prints it on Fedora 44, recorded). PipeWire runs in the `intentic` user's systemd user manager, which linger starts at boot,
so the machine agent's tool call reaches the same sound server as the screen's session, with nobody signed in
(tool::capture_in_session names the session's folder for a caller whose environment does not).

wpctl's volume is the one a person sees on a slider (cubic): 0.40 is 40%. Above 1.0 is louder than the device's own
maximum, which these verbs never set and the status reads as 100. */

/// wpctl answers from the running server.
const WPCTL_LIMIT: Duration = Duration::from_secs(10);

/// The node every volume and mute change goes to: whatever plays now.
const DEFAULT_SINK: &str = "@DEFAULT_AUDIO_SINK@";

/// One place sound plays, as `wpctl status` lists it under Audio, Sinks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sink {
    pub id: u32,
    pub name: String,
    pub default: bool,
}

/// The sinks in what `wpctl status` printed: the `Sinks:` group of the `Audio` section, each line
/// `│  *   49. Built-in Audio Analog Stereo        [vol: 0.40]` with `*` on the default. Pure.
pub fn sinks(status: &str) -> Vec<Sink> {
    let mut in_audio = false;
    let mut in_sinks = false;
    let mut found = Vec::new();
    for line in status.lines() {
        if !line.starts_with(' ') && !line.starts_with('│') && !line.trim().is_empty() {
            // A section heading (`Audio`, `Video`, `Settings`), or the server's own line.
            in_audio = line.trim() == "Audio";
            in_sinks = false;
            continue;
        }
        if !in_audio {
            continue;
        }
        let body = line.trim_start_matches([' ', '│']).trim_end();
        if let Some(heading) = body.strip_prefix("├─").or_else(|| body.strip_prefix("└─")) {
            in_sinks = heading.trim() == "Sinks:";
            continue;
        }
        if !in_sinks || body.is_empty() {
            continue;
        }
        let (default, entry) = match body.strip_prefix('*') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, body),
        };
        let Some((id, rest)) = entry.split_once(". ") else {
            continue;
        };
        let Ok(id) = id.trim().parse::<u32>() else {
            continue;
        };
        let name = rest.split(" [vol:").next().unwrap_or(rest).trim();
        if name.is_empty() {
            continue;
        }
        found.push(Sink {
            id,
            name: name.to_string(),
            default,
        });
    }
    found
}

/// What `wpctl get-volume` printed (`Volume: 0.40`, `Volume: 0.40 [MUTED]`): the percent a person sees, at most 100,
/// and whether it is muted. Pure.
pub fn volume_of(said: &str) -> Option<(u8, bool)> {
    let rest = said.trim().strip_prefix("Volume:")?.trim();
    let mut words = rest.split_whitespace();
    let level: f64 = words.next()?.parse().ok()?;
    let muted = words.any(|word| word == "[MUTED]");
    let percent = (level * 100.0).round().clamp(0.0, 100.0) as u8;
    Some((percent, muted))
}

/// `ic os sound status --json`: `{volume, muted, output}`, with output the default sink's name; a machine with nothing
/// to play on reads 0, not muted, no output. Pure.
pub fn status_value(sinks: &[Sink], volume: Option<(u8, bool)>) -> Value {
    let Some(output) = sinks.iter().find(|sink| sink.default) else {
        return json!({ "volume": 0, "muted": false, "output": null });
    };
    let (volume, muted) = volume.unwrap_or((0, false));
    json!({ "volume": volume, "muted": muted, "output": output.name })
}

/// `ic os sound outputs --json`. Pure.
pub fn outputs_value(sinks: &[Sink]) -> Value {
    json!({
        "outputs": sinks
            .iter()
            .map(|sink| json!({ "id": sink.id, "name": sink.name, "default": sink.default }))
            .collect::<Vec<_>>(),
    })
}

/// A volume as wpctl takes it: 40 → `0.40`. Pure.
pub fn level(percent: u8) -> String {
    format!("{:.2}", f64::from(percent.min(100)) / 100.0)
}

fn wpctl(args: &[&str]) -> Result<String> {
    tool::capture_in_session("wpctl", args, WPCTL_LIMIT).map_err(|err| {
        crate::util::Fail(format!(
            "The sound service did not answer for this user. ({})",
            err.0
        ))
    })
}

fn read_sinks() -> Result<Vec<Sink>> {
    Ok(sinks(&wpctl(&["status"])?))
}

/// The status now: the sinks, and the default one's volume when there is one.
fn read_status() -> Result<Value> {
    let sinks = read_sinks()?;
    let volume = if sinks.iter().any(|sink| sink.default) {
        volume_of(&wpctl(&["get-volume", DEFAULT_SINK])?)
    } else {
        None
    };
    Ok(status_value(&sinks, volume))
}

fn show(status: &Value) {
    match status["output"].as_str() {
        None => crate::ui::quiet("This machine has no speaker or headphones."),
        Some(output) => crate::ui::done(&format!(
            "{}% on {output}{}.",
            status["volume"],
            if status["muted"] == true {
                ", muted"
            } else {
                ""
            }
        )),
    }
}

/// `ic os sound status [--json]`.
pub fn status(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let status = read_status()?;
    if json {
        super::emit_json(&status);
    } else {
        show(&status);
    }
    Ok(())
}

/// What `ic os sound set` was asked to change.
pub struct Change {
    pub volume: Option<u8>,
    /// Some(true) to mute, Some(false) to unmute.
    pub muted: Option<bool>,
    pub json: bool,
}

/// `ic os sound set [--volume N] [--mute|--unmute] [--json]`: the change, then the status after it.
pub fn set(change: Change) -> Result<()> {
    if change.json {
        crate::ui::send_human_to_stderr();
    }
    if change.volume.is_none() && change.muted.is_none() {
        bail!("Say what to change: --volume 0-100, --mute or --unmute.");
    }
    if change.volume.is_some_and(|volume| volume > 100) {
        bail!("A volume is 0 to 100.");
    }
    if !read_sinks()?.iter().any(|sink| sink.default) {
        bail!("This machine has no speaker or headphones to set.");
    }
    if let Some(volume) = change.volume {
        // `-l 1.0`: never louder than the device's own maximum, whatever is asked.
        wpctl(&["set-volume", "-l", "1.0", DEFAULT_SINK, &level(volume)])?;
    }
    if let Some(muted) = change.muted {
        wpctl(&["set-mute", DEFAULT_SINK, if muted { "1" } else { "0" }])?;
    }
    let status = read_status()?;
    if change.json {
        super::emit_json(&status);
    } else {
        show(&status);
    }
    Ok(())
}

/// `ic os sound outputs [--json]`.
pub fn outputs(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let sinks = read_sinks()?;
    if json {
        super::emit_json(&outputs_value(&sinks));
        return Ok(());
    }
    if sinks.is_empty() {
        crate::ui::quiet("This machine has no speaker or headphones.");
        return Ok(());
    }
    crate::ui::report("Where sound plays", None);
    let fields: Vec<(String, String)> = sinks
        .iter()
        .map(|sink| {
            (
                sink.id.to_string(),
                format!(
                    "{}{}",
                    sink.name,
                    if sink.default { " (in use)" } else { "" }
                ),
            )
        })
        .collect();
    crate::ui::fields(&fields);
    Ok(())
}

/// `ic os sound output <id>`: play on that one from now on. Only a sink's id is taken: a microphone's or a camera's is
/// refused before wpctl would make it the default of its own kind.
pub fn output(id: u32) -> Result<()> {
    let sinks = read_sinks()?;
    let Some(sink) = sinks.iter().find(|sink| sink.id == id) else {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("{id} is not a speaker or headphones on this machine."),
                None,
                Some("ic os sound outputs"),
            )
        );
    };
    wpctl(&["set-default", &id.to_string()])?;
    crate::ui::done(&format!("Sound plays on {} now.", sink.name));
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixture {
    /// `wpctl status` as WirePlumber 0.5.18 on PipeWire 1.6.9 prints it (recorded 2026-10-16 in Fedora 44's desktop
    /// image, with two sinks named as a laptop's speakers and an HDMI screen): the speakers chosen, the HDMI screen
    /// muted, a microphone, and a camera whose Video sources must not be read as sinks. The tree's spacer lines end in
    /// two spaces, as wpctl prints them.
    pub const STATUS: &str = "PipeWire 'pipewire-0' [1.6.9, intentic@box, cookie:3476764161]
 └─ Clients:
        31. WirePlumber                         [1.6.9, intentic@box, pid:18]
        40. WirePlumber [client]                [1.6.9, intentic@box, pid:18]
        41. wpctl                               [1.6.9, intentic@box, pid:32]

Audio
 ├─ Devices:
 │      42. Built-in Audio                      [alsa]
 │  
 ├─ Sinks:
 │  *   49. Built-in Audio Analog Stereo        [vol: 0.40]
 │      58. HDMI / DisplayPort 1 Output         [vol: 1.00 MUTED]
 │  
 ├─ Sources:
 │  *   50. Built-in Audio Analog Stereo        [vol: 1.00]
 │  
 ├─ Filters:
 │  
 └─ Streams:

Video
 ├─ Devices:
 │      44. Integrated Camera                   [v4l2]
 │  
 ├─ Sinks:
 │  
 ├─ Sources:
 │  *   52. Integrated Camera (V4L2)
 │  
 ├─ Filters:
 │  
 └─ Streams:

Settings
 └─ Default Configured Devices:
         0. Audio/Sink    alsa_output.pci-0000_00_1f.3.analog-stereo
         1. Audio/Source  alsa_input.pci-0000_00_1f.3.analog-stereo
";

    /// The same machine with the HDMI screen chosen as where sound plays.
    pub fn status_on_hdmi() -> String {
        STATUS
            .replace("│  *   49.", "│      49.")
            .replace("│      58.", "│  *   58.")
    }

    /// A machine with no sound card, exactly as recorded (WirePlumber 0.5.18, Fedora 44's desktop image in a container).
    pub const STATUS_SILENT: &str =
        "PipeWire 'pipewire-0' [1.6.9, tester@d5160bbabf23, cookie:3476764161]
 └─ Clients:
        31. WirePlumber                         [1.6.9, tester@d5160bbabf23, pid:18]
        40. WirePlumber [client]                [1.6.9, tester@d5160bbabf23, pid:18]
        41. wpctl                               [1.6.9, tester@d5160bbabf23, pid:32]

Audio
 ├─ Devices:
 │  
 ├─ Sinks:
 │  
 ├─ Sources:
 │  
 ├─ Filters:
 │  
 └─ Streams:

Video
 ├─ Devices:
 │  
 ├─ Sinks:
 │  
 ├─ Sources:
 │  
 ├─ Filters:
 │  
 └─ Streams:

Settings
 └─ Default Configured Devices:
";
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON")
    }

    #[test]
    fn the_audio_sinks_are_read_and_nothing_else() {
        assert_eq!(
            sinks(fixture::STATUS),
            vec![
                Sink {
                    id: 49,
                    name: "Built-in Audio Analog Stereo".into(),
                    default: true
                },
                Sink {
                    id: 58,
                    name: "HDMI / DisplayPort 1 Output".into(),
                    default: false
                },
            ]
        );
        assert_eq!(sinks(fixture::STATUS_SILENT), vec![]);
        assert_eq!(sinks(""), vec![]);
    }

    #[test]
    fn a_volume_reads_as_the_percent_a_person_sees() {
        assert_eq!(volume_of("Volume: 0.40"), Some((40, false)));
        assert_eq!(volume_of("Volume: 0.40 [MUTED]\n"), Some((40, true)));
        assert_eq!(volume_of("Volume: 1.53"), Some((100, false)));
        assert_eq!(volume_of("Volume: 0.005"), Some((1, false)));
        assert_eq!(volume_of("nothing"), None);
        // What wpctl 0.5.18 prints, exiting 0, when there is no sink to ask.
        assert_eq!(
            volume_of(
                "Translate ID error: '-1' is not a valid ID (returned by default-nodes-api)\n"
            ),
            None
        );
        assert_eq!(level(40), "0.40");
        assert_eq!(level(100), "1.00");
        assert_eq!(level(0), "0.00");
        assert_eq!(level(7), "0.07");
    }

    #[test]
    fn every_sound_status_and_output_list_the_contract_shows_is_what_the_mapping_makes() {
        let golden = golden();
        let statuses = golden["soundStatus"].as_array().expect("examples");
        assert_eq!(
            status_value(&sinks(fixture::STATUS), volume_of("Volume: 0.40")),
            statuses[0]
        );
        assert_eq!(
            status_value(
                &sinks(&fixture::status_on_hdmi()),
                volume_of("Volume: 1.00 [MUTED]")
            ),
            statuses[1]
        );
        assert_eq!(
            status_value(&sinks(fixture::STATUS_SILENT), None),
            statuses[2]
        );
        let outputs = golden["soundOutputs"].as_array().expect("examples");
        assert_eq!(outputs_value(&sinks(fixture::STATUS)), outputs[0]);
        assert_eq!(outputs_value(&sinks(fixture::STATUS_SILENT)), outputs[1]);
    }
}
