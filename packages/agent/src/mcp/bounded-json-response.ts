const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function withBody(response: Response, body: BodyInit): Response {
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // OAuth discovery can inspect the final response URL after same-origin redirects.
  Object.defineProperties(bounded, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return bounded;
}

/** Byte framing precedes UTF-8 decoding; CRLF may straddle any two source chunks. */
function sseFrameLimit(maximum: number) {
  let frameBytes = 0;
  let lineBytes = 0;
  let pendingCR = false;
  const count = () => {
    if (++frameBytes > maximum) throw new Error("MCP SSE event exceeds size limit");
  };
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      if (pendingCR) {
        pendingCR = false;
        if (byte === 10) {
          count();
          if (lineBytes === 0) frameBytes = 0;
          lineBytes = 0;
          continue;
        }
        if (lineBytes === 0) frameBytes = 0;
        lineBytes = 0;
      }
      count();
      if (byte === 13) pendingCR = true;
      else if (byte === 10) {
        if (lineBytes === 0) frameBytes = 0;
        lineBytes = 0;
      } else lineBytes++;
    }
  };
}

/** Recognize a complete legacy endpoint event without buffering the rest of the stream. */
function legacyEndpointProbe() {
  let line = "";
  let event = "";
  let hasData = false;
  let afterCR = false;
  let remaining = 64 * 1024;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      if (remaining-- <= 0) return "modern";
      if (afterCR && byte === 10) {
        afterCR = false;
        continue;
      }
      afterCR = byte === 13;
      if (byte === 10 || afterCR) {
        if (line === "") {
          if (hasData) {
            return event === "endpoint" ? "legacy" : "modern";
          }
          event = "";
        } else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
        else if (line === "data" || line.startsWith("data:")) hasData = true;
        line = "";
      } else if (line.length < 32) line += String.fromCharCode(byte);
    }
  };
}

function boundedSseResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  maximum: number,
  initialChunks: Uint8Array[],
): Response {
  const inspect = sseFrameLimit(maximum);
  let finished = false;
  let disposal: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const dispose = (reason?: unknown) => {
    if (disposal) return disposal;
    finished = true;
    signal.removeEventListener("abort", abort);
    disposal = (async () => {
      // A cancelled fetch body may already reject; cleanup never replaces the fixed failure.
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    })();
    return disposal;
  };
  const abort = () => {
    if (finished) return;
    controller.error(signal.reason);
    void dispose(signal.reason);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(value) {
        try {
          const buffered = initialChunks.shift();
          const item = buffered ? { done: false as const, value: buffered } : await reader.read();
          if (finished) return;
          signal.throwIfAborted();
          if (item.done) {
            await dispose();
            value.close();
          } else {
            inspect(item.value);
            value.enqueue(item.value);
          }
        } catch (error) {
          if (finished) return;
          value.error(error);
          await dispose(error);
        }
      },
      cancel: dispose,
    },
    { highWaterMark: 0 },
  );
  return withBody(response, body);
}

/** Each SSE event is bounded independently; an arbitrarily long series remains streaming. */
export async function boundedMcpResponse(
  response: Response,
  signal: AbortSignal,
  maximum = MAX_RESPONSE_BYTES,
  legacyEndpoint?: () => void,
): Promise<Response> {
  if (
    response.body &&
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
      "text/event-stream"
  ) {
    const reader = response.body.getReader();
    const initialChunks: Uint8Array[] = [];
    if (legacyEndpoint) {
      const inspect = legacyEndpointProbe();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        for (;;) {
          const item = await reader.read();
          signal.throwIfAborted();
          if (item.done) break;
          initialChunks.push(item.value);
          const status = inspect(item.value);
          if (status === "legacy") {
            legacyEndpoint();
            throw new Error("MCP legacy SSE endpoint");
          }
          if (status === "modern") break;
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    return boundedSseResponse(response, reader, signal, maximum, initialChunks);
  }
  return boundedBodyResponse(response, signal, maximum);
}

/** Limit before SDK parsing; its output guard runs after the entire JSON body is in memory. */
async function boundedBodyResponse(
  response: Response,
  signal: AbortSignal,
  maximum = MAX_RESPONSE_BYTES,
): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const cancel = () => {
    // The read loop checks the signal after cancellation; cleanup errors contain no useful facts.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maximum)
      throw new Error("MCP response exceeds size limit");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) throw new Error("MCP response exceeds size limit");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return withBody(response, bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    // Releasing a response after a size failure must also stop its upstream download.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
