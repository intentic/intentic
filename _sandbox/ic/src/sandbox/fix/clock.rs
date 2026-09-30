/* THE TWO TIMESTAMPS A DIAGNOSIS READS, without a date crate: the platform's `Date` header (is this machine's clock
right?) and docker's `State.StartedAt` (how long has this container been up?). Both are UTC, and both parse into the
same days-from-civil arithmetic util::timestamp uses the other way round. */

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil). Pure.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn epoch(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> Option<i64> {
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && (0..24).contains(&hour)
        && (0..60).contains(&minute)
        && (0..=60).contains(&second);
    valid.then(|| days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

fn clock_of(hms: &str) -> Option<(i64, i64, i64)> {
    let mut parts = hms.split(':').map(|part| part.parse::<i64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// An HTTP `Date` (IMF-fixdate, `Sun, 06 Nov 1994 08:49:37 GMT`, the only form a server may send) in epoch
/// seconds. Pure.
pub fn http_date_secs(value: &str) -> Option<i64> {
    let mut words = value.split_whitespace();
    let _weekday = words.next()?;
    let day: i64 = words.next()?.parse().ok()?;
    let month = match words.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = words.next()?.parse().ok()?;
    let (hour, minute, second) = clock_of(words.next()?)?;
    epoch(year, month, day, hour, minute, second)
}

/// Docker's RFC 3339 time (`2026-09-30T10:00:00.123456789Z`) in epoch milliseconds. Docker's never-started zero
/// value (`0001-01-01T00:00:00Z`) reads as None. Pure.
pub fn rfc3339_ms(value: &str) -> Option<u64> {
    let value = value.trim();
    let (date, time) = value.split_once('T')?;
    let mut ymd = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (ymd.next()??, ymd.next()??, ymd.next()??);
    if year < 1970 {
        return None;
    }
    let time = time.trim_end_matches('Z');
    // An offset other than Z is not something docker writes; refuse rather than misread it.
    if time.contains('+') || time.matches('-').count() > 0 {
        return None;
    }
    let (hms, fraction) = time.split_once('.').unwrap_or((time, ""));
    let (hour, minute, second) = clock_of(hms)?;
    let secs = epoch(year, month, day, hour, minute, second)?;
    let millis: u64 = fraction
        .chars()
        .chain(std::iter::repeat('0'))
        .take(3)
        .collect::<String>()
        .parse()
        .ok()?;
    Some(secs as u64 * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_http_date_is_read_as_the_rfc_example_says() {
        // RFC 9110's own example, and the epoch, by value.
        assert_eq!(
            http_date_secs("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777)
        );
        assert_eq!(http_date_secs("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(
            http_date_secs("Wed, 30 Sep 2026 12:00:00 GMT"),
            Some(1_790_769_600)
        );
        assert_eq!(http_date_secs("yesterday"), None);
        assert_eq!(http_date_secs("Sun, 06 Foo 1994 08:49:37 GMT"), None);
    }

    #[test]
    fn dockers_start_time_is_read_to_the_millisecond_and_its_zero_value_is_none() {
        assert_eq!(
            rfc3339_ms("2026-09-30T12:00:00.123456789Z"),
            Some(1_790_769_600_123)
        );
        assert_eq!(rfc3339_ms("2026-09-30T12:00:00Z"), Some(1_790_769_600_000));
        assert_eq!(rfc3339_ms("0001-01-01T00:00:00Z"), None);
        assert_eq!(rfc3339_ms("2026-09-30T12:00:00+02:00"), None);
        assert_eq!(rfc3339_ms(""), None);
    }
}
