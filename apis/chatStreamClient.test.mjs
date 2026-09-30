import test from "node:test";
import assert from "node:assert/strict";

import { sendMessageStream } from "./chatStreamClient.js";

const originalFetch = globalThis.fetch;

function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("accepted request id survives an incomplete stream so caller can recover durable run", async () => {
  const accepted = [];
  const errors = [];

  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"accepted","request_id":"42","status":"processing"}\n\n',
      'data: {"type":"token","request_id":"42","delta":"부분 답변"}\n\n',
      // transport closes without a terminal event
    ]);

  await sendMessageStream({
    sessionId: "10",
    content: "질문",
    idempotencyKey: "idem-1",
    onAccepted: (event) => accepted.push(event),
    onError: (event) => errors.push(event),
  });

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].request_id, "42");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "STREAM_INCOMPLETE");
});

test("completed stream does not emit incomplete error", async () => {
  const done = [];
  const errors = [];

  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"accepted","request_id":"77","status":"processing"}\n\n',
      'data: {"type":"done","request_id":"77","payload":{"chat_session_id":"10"}}\n\n',
    ]);

  await sendMessageStream({
    sessionId: "10",
    content: "질문",
    onDone: (payload, event) => done.push({ payload, event }),
    onError: (event) => errors.push(event),
  });

  assert.equal(done.length, 1);
  assert.equal(done[0].event.request_id, "77");
  assert.equal(errors.length, 0);
});
