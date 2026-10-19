package dev.intentic.spike.compose

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

/** Arm A's palette (android/app/src/main/res/values/colors.xml), so the arms look alike. */
object Look {
    val canvas = Color(0xFF15171C)
    val card = Color(0xFF22262E)
    val content = Color(0xFFE6E8EC)
    val muted = Color(0xFF8B93A1)
    val accent = Color(0xFF7AA2F7)
    val rule = Color(0xFF3A404C)
}

private val colors = darkColorScheme(
    primary = Look.accent,
    onPrimary = Look.canvas,
    background = Look.canvas,
    onBackground = Look.content,
    surface = Look.canvas,
    onSurface = Look.content,
    surfaceVariant = Look.card,
    onSurfaceVariant = Look.muted,
    surfaceContainerHighest = Look.card,
    outline = Look.rule,
    outlineVariant = Look.rule,
)

// The markdown renderer takes its sizes from the theme: body text (`bodyLarge`) at 15sp, code (`bodyMedium`) at 13sp.
private val typography = Typography().run {
    copy(
        bodyLarge = bodyLarge.copy(fontSize = 15.sp, lineHeight = 21.sp, letterSpacing = 0.sp),
        bodyMedium = bodyMedium.copy(fontSize = 13.sp, lineHeight = 19.sp, letterSpacing = 0.sp),
        bodySmall = bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
    )
}

/** The editor's dark look as a Material 3 theme. */
@Composable
fun SpikeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, typography = typography, content = content)
}

val Mono = FontFamily.Monospace
