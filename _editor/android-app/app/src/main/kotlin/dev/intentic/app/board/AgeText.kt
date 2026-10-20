package dev.intentic.app.board

import android.content.Context
import android.icu.text.MeasureFormat
import android.icu.text.RelativeDateTimeFormatter
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.icu.util.ULocale
import android.icu.text.DisplayContext
import android.text.format.DateUtils

/**
 * An [Age] in words, and a wait in seconds, in the phone's language. The wording is CLDR's, through ICU, as the web's
 * is through Intl: units no translator writes ("2m", "2 Min.", "2 min"), and "now" in each language.
 */
class AgeText(private val context: Context) {
    private val locale = context.resources.configuration.locales[0]
    private val units = MeasureFormat.getInstance(locale, MeasureFormat.FormatWidth.NARROW)
    private val relative = RelativeDateTimeFormatter.getInstance(
        ULocale.forLocale(locale),
        null,
        RelativeDateTimeFormatter.Style.NARROW,
        DisplayContext.CAPITALIZATION_FOR_STANDALONE,
    )

    fun of(age: Age): String =
        when (age) {
            Age.Now -> relative.format(RelativeDateTimeFormatter.Direction.PLAIN, RelativeDateTimeFormatter.AbsoluteUnit.NOW)
            is Age.Minutes -> units.format(Measure(age.count, MeasureUnit.MINUTE))
            is Age.Hours -> units.format(Measure(age.count, MeasureUnit.HOUR))
            is Age.Days -> units.format(Measure(age.count, MeasureUnit.DAY))
            is Age.On -> DateUtils.formatDateTime(
                context,
                age.at,
                DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or DateUtils.FORMAT_NO_YEAR,
            )
        }

    fun seconds(count: Int): String = units.format(Measure(count, MeasureUnit.SECOND))
}
