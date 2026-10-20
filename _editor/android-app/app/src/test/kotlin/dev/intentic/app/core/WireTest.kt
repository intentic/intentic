package dev.intentic.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

// The same JSON the Rust side's own test pins (src/bridge/messages.rs), read from the Kotlin side: if typeshare's shape
// or the discriminator ever drifts, the two tests stop agreeing.
class WireTest {
    @Test
    fun aRequestCrossesAsTheTaggedJsonRustReads() {
        assertEquals("""{"type":"Ping","content":{"echo":"hi"}}""", Wire.encode(Request.Ping(RequestPingInner(echo = "hi"))))
    }

    @Test
    fun anEventRustWritesDecodesToItsVariant() {
        val event = Wire.decodeEvent("""{"type":"Reply","content":{"id":7,"outcome":{"type":"Pong","content":{"echo":"hi"}}}}""")
        assertEquals(Event.Reply(EventReplyInner(id = 7, outcome = Outcome.Pong(OutcomePongInner(echo = "hi")))), event)
    }

    @Test
    fun aFailedOutcomeDecodesWithItsMessage() {
        val event = Wire.decodeEvent("""{"type":"Reply","content":{"id":1,"outcome":{"type":"Failed","content":{"message":"no"}}}}""")
        assertEquals(Outcome.Failed(OutcomeFailedInner(message = "no")), (event as Event.Reply).content.outcome)
    }

    @Test
    fun aUnitVariantCrossesAsItsTagAlone() {
        // Rust writes an adjacently tagged unit variant with no "content" at all, both ways.
        assertEquals("""{"type":"SignOut"}""", Wire.encode(Request.SignOut))
        val event = Wire.decodeEvent("""{"type":"Reply","content":{"id":2,"outcome":{"type":"Done"}}}""")
        assertEquals(Outcome.Done, (event as Event.Reply).content.outcome)
    }

    @Test
    fun aUnitOnlyEnumCrossesAsAPlainString() {
        val event = Wire.decodeEvent(
            """{"type":"Board","content":{"sandbox":"s1","cards":[{"id":"a1","title":null,"lane":"Attention",""" +
                """"status":"awaiting","working":false,"unread":true,"model":null,"activity":null,"failure":null,""" +
                """"updatedAt":1760900000000.0,"parent":null,"checklistDone":2,"checklistTotal":5}]}}""",
        )
        val card = (event as Event.Board).content.cards.single()
        assertEquals(BoardLane.Attention, card.lane)
        assertEquals(2u, card.checklistDone)
    }

    @Test
    fun aVariantRenamedToCamelCaseInRustDecodes() {
        val event = Wire.decodeEvent("""{"type":"Link","content":{"sandbox":"s1","state":{"type":"Reconnecting","content":{"retryInMs":500}}}}""")
        assertEquals(LinkState.Reconnecting(LinkStateReconnectingInner(retryInMs = 500u)), (event as Event.Link).content.state)
    }

    @Test
    fun aCardAnswerCrossesWithTheCamelCaseFieldsRustReads() {
        val answer = Request.Answer(RequestAnswerInner(CardAnswer.Plan(CardAnswerPlanInner(requestId = "r1", approve = true))))
        assertEquals("""{"type":"Answer","content":{"answer":{"type":"Plan","content":{"requestId":"r1","approve":true}}}}""", Wire.encode(answer))
        val sent = Request.Send(RequestSendInner(agent = null, text = "hi", attachments = emptyList()))
        assertEquals("""{"type":"Send","content":{"text":"hi","attachments":[]}}""", Wire.encode(sent))
    }

    @Test
    fun aCardRowDecodesForItsButtons() {
        val card = Wire.decodeCard(
            """{"kind":"Question","requestId":"q1","pending":true,"questions":[{"question":"Which?","header":null,""" +
                """"multiSelect":false,"options":[{"label":"A","description":null}]}],"alwaysLabel":null}""",
        )
        assertEquals(CardRowKind.Question, card.kind)
        assertEquals("A", card.questions.single().options.single().label)
    }

    @Test
    fun theConfigUsesTheCamelCaseNamesRustRenames() {
        val json = Wire.encode(Config(apiUrl = "https://api.example", webUrl = "https://app.example", secretKey = "a2V5"))
        assertEquals("""{"apiUrl":"https://api.example","webUrl":"https://app.example","secretKey":"a2V5"}""", json)
    }
}
