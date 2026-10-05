package dev.intentic.device.link

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

/** The sandbox's WebSocket over OkHttp. */
class OkHttpSockets(private val client: OkHttpClient) : LinkSocketFactory {
    override fun open(url: String, listener: LinkSocketListener): LinkSocket {
        val socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

                override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)

                // The sandbox only speaks text; a binary frame is read as the text it carries rather than dropped.
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.onMessage(bytes.utf8())

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Answer the close so the far end is not left waiting, and tell the controller the code now: 1008 matters.
                    webSocket.close(1000, null)
                    listener.onEnded(code)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onEnded(code)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onEnded(null)
            },
        )
        return object : LinkSocket {
            override fun send(text: String): Boolean = socket.send(text)

            override fun close(code: Int, reason: String) {
                socket.close(code, reason)
            }

            override fun cancel() = socket.cancel()
        }
    }

    companion object {
        /** No read timeout: the link is idle between calls, and the controller's own watchdog decides when it is dead. */
        fun client(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
    }
}
