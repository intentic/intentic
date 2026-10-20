package dev.intentic.app.secret

import java.io.File
import java.nio.file.Files
import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A plain JVM AES key stands in for the Keystore's: the wrapping and the file's life are what is under test.
class CoreSecretTest {
    private val dir: File = Files.createTempDirectory("core-secret").toFile()
    private val file = File(dir, "core-secret")
    private val key: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val wrap = KeyWrap { key }

    @Test
    fun theFirstLoadMakes32BytesAndKeepsThemOnlyWrapped() {
        val secret = Base64.getDecoder().decode(CoreSecret(file, wrap).load())
        assertEquals(32, secret.size)
        val kept = file.readText()
        assertFalse("the raw secret is not on disk", kept.contains(Base64.getEncoder().encodeToString(secret)))
        assertTrue(kept.matches(Regex("[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+")))
        assertTrue(wrap.unwrap(kept)!!.contentEquals(secret))
    }

    @Test
    fun aLaterLoadReturnsTheSameSecret() {
        val first = CoreSecret(file, wrap).load()
        assertEquals(first, CoreSecret(file, wrap).load())
        assertFalse(File(dir, "core-secret.partial").exists())
    }

    @Test
    fun aFileAnotherKeyWroteIsReplacedByAFreshSecret() {
        val first = CoreSecret(file, wrap).load()
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val second = CoreSecret(file, KeyWrap { otherKey }).load()
        assertNotEquals(first, second)
        assertEquals(second, CoreSecret(file, KeyWrap { otherKey }).load())
    }

    @Test
    fun unwrapRefusesWhatWasAltered() {
        val wrapped = wrap.wrap(ByteArray(32) { it.toByte() })
        val (iv, body) = wrapped.split('.')
        val flipped = Base64.getDecoder().decode(body).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertNull(wrap.unwrap("$iv.${Base64.getEncoder().encodeToString(flipped)}"))
        assertNull(wrap.unwrap("not wrapped"))
        assertNull(wrap.unwrap("@@.@@"))
    }
}
