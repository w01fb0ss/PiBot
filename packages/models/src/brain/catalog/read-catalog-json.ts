export async function readCatalogJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Missing catalog response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    if (!response.ok) throw new Error("Catalog HTTP error");
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Catalog response too large");
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    await reader.cancel().catch(() => {
      // A stream that failed or was aborted is already closed by fetch.
    });
    reader.releaseLock();
  }
}
