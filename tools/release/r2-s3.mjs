// Zero-dependency Cloudflare R2 S3-compatible uploader (single PUT + 16 MiB multipart)
// and public download verifier. Avoids Wrangler's 300 MiB object upload limit.
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

const PART_SIZE = 16 * 1024 * 1024;
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const MAX_RETRIES = 3;

export function r2ConfigFromEnv(env = process.env) {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim() || "pibot-releases";
  if (!accountId || !accessKeyId || !secretAccessKey) return undefined;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(searchParams) {
  const pairs = [...searchParams.entries()].sort(([aKey, aVal], [bKey, bVal]) =>
    aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
  );
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}

function signRequest({ config, method, url, headers = {}, payloadHash }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";

  const canonicalHeadersMap = new Map();
  canonicalHeadersMap.set("host", url.host);
  canonicalHeadersMap.set("x-amz-content-sha256", payloadHash);
  canonicalHeadersMap.set("x-amz-date", amzDate);
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) canonicalHeadersMap.set(k.toLowerCase(), String(v).trim());
  }

  const sortedNames = [...canonicalHeadersMap.keys()].sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${canonicalHeadersMap.get(name)}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalUri = url.pathname
    .split("/")
    .map((seg) => encodeRfc3986(decodeURIComponent(seg)))
    .join("/");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const out = new Headers();
  for (const [k, v] of canonicalHeadersMap) {
    if (k !== "host") out.set(k, v);
  }
  out.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return out;
}

async function s3Fetch({ config, method, key, query, headers = {}, body, signal }) {
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const signedHeaders = signRequest({ config, method, url, headers, payloadHash });
  const response = await fetch(url, {
    method,
    headers: signedHeaders,
    body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : payload,
    redirect: "error",
    signal,
  });
  return response;
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const waitMs = attempt * 2000;
        console.warn(`${label}: attempt ${attempt} failed, retrying in ${waitMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastError;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function uploadSingle({ config, key, filePath, contentType, size, signal }) {
  const fh = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await fh.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const payload = offset === size ? buffer : buffer.subarray(0, offset);
    await withRetry(`PUT ${key}`, async () => {
      const response = await s3Fetch({
        config,
        method: "PUT",
        key,
        headers: { "content-type": contentType, "content-length": String(payload.byteLength) },
        body: payload,
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`R2 PUT ${key} failed (${response.status}): ${detail.slice(0, 300)}`);
      }
    });
  } finally {
    await fh.close();
  }
}

async function uploadMultipart({ config, key, filePath, contentType, size, signal }) {
  const initResponse = await s3Fetch({
    config,
    method: "POST",
    key,
    query: { uploads: "" },
    headers: { "content-type": contentType },
    signal,
  });
  if (!initResponse.ok) {
    const detail = await initResponse.text().catch(() => "");
    throw new Error(
      `R2 CreateMultipartUpload ${key} failed (${initResponse.status}): ${detail.slice(0, 300)}`,
    );
  }
  const initXml = await initResponse.text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)?.[1];
  if (!uploadId) throw new Error(`R2 CreateMultipartUpload ${key} returned no UploadId`);

  const parts = [];
  const totalParts = Math.ceil(size / PART_SIZE);
  const fh = await open(filePath, "r");
  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * PART_SIZE;
      const length = Math.min(PART_SIZE, size - start);
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await fh.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const chunk = offset === length ? buffer : buffer.subarray(0, offset);
      const etag = await withRetry(`UploadPart ${key} ${partNumber}/${totalParts}`, async () => {
        const res = await s3Fetch({
          config,
          method: "PUT",
          key,
          query: { partNumber: String(partNumber), uploadId },
          headers: { "content-length": String(chunk.byteLength) },
          body: chunk,
          signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(
            `R2 UploadPart ${key}#${partNumber} failed (${res.status}): ${detail.slice(0, 300)}`,
          );
        }
        const tag = res.headers.get("etag");
        if (!tag) throw new Error(`R2 UploadPart ${key}#${partNumber} returned no ETag`);
        return tag;
      });
      parts.push({ partNumber, etag });
      console.log(`  part ${partNumber}/${totalParts} uploaded (${key})`);
    }
    const completeXml = [
      "<CompleteMultipartUpload>",
      ...parts.map(
        ({ partNumber, etag }) =>
          `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
      ),
      "</CompleteMultipartUpload>",
    ].join("");
    const completeRes = await withRetry(`CompleteMultipartUpload ${key}`, async () => {
      const res = await s3Fetch({
        config,
        method: "POST",
        key,
        query: { uploadId },
        headers: { "content-type": "application/xml" },
        body: Buffer.from(completeXml, "utf8"),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `R2 CompleteMultipartUpload ${key} failed (${res.status}): ${detail.slice(0, 300)}`,
        );
      }
      return res;
    });
    await completeRes.text();
  } catch (error) {
    // Clean up aborted multipart parts so failed uploads do not accumulate storage in R2.
    await s3Fetch({
      config,
      method: "DELETE",
      key,
      query: { uploadId },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    throw error;
  } finally {
    await fh.close();
  }
}

export async function uploadR2Object({ config, key, filePath, contentType, signal }) {
  const { size } = await stat(filePath);
  const requestSignal = signal ?? AbortSignal.timeout(30 * 60_000);
  if (size <= MULTIPART_THRESHOLD) {
    await uploadSingle({ config, key, filePath, contentType, size, signal: requestSignal });
  } else {
    console.log(
      `Multipart upload ${key} (${(size / (1024 * 1024)).toFixed(1)} MiB in ${Math.ceil(size / PART_SIZE)} parts)...`,
    );
    await uploadMultipart({ config, key, filePath, contentType, size, signal: requestSignal });
  }
  return { size };
}

async function fileSha512Base64(stream) {
  const hash = createHash("sha512");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("base64");
}

async function fileSha256Hex(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPublicObject({ filePath, url, size }) {
  const signal = AbortSignal.timeout(300_000);
  const head = await fetch(url, { method: "HEAD", redirect: "error", signal });
  if (!head.ok || head.headers.get("content-length") !== String(size)) {
    return { ok: false, status: head.status };
  }
  const etag = (head.headers.get("etag") ?? "").replace(/^W\//u, "").replace(/^"|"$/gu, "");
  if (/^[a-f0-9]{32}$/u.test(etag)) {
    const md5 = createHash("md5");
    for await (const chunk of createReadStream(filePath)) md5.update(chunk);
    if (md5.digest("hex") === etag) {
      return { ok: true, etag, verifiedBy: "md5-etag", sha256: await fileSha256Hex(filePath) };
    }
  }
  const multipart = /^[a-f0-9]{32}-(\d+)$/u.exec(etag);
  if (multipart) {
    for (const partMiB of [16, 8, 5]) {
      const partSize = partMiB * 1024 * 1024;
      const partCount = Math.ceil(size / partSize);
      if (Number(multipart[1]) !== partCount) continue;
      const md5 = createHash("md5");
      let actualParts = 0;
      for await (const part of createReadStream(filePath, { highWaterMark: partSize })) {
        md5.update(createHash("md5").update(part).digest());
        actualParts++;
      }
      if (actualParts === partCount && `${md5.digest("hex")}-${actualParts}` === etag) {
        return {
          ok: true,
          etag,
          verifiedBy: `multipart-${partMiB}m-etag`,
          sha256: await fileSha256Hex(filePath),
        };
      }
    }
  }
  const response = await fetch(url, { redirect: "error", signal });
  if (!response.ok || response.body === null) return { ok: false, status: response.status };
  const [remoteHash, localHash] = await Promise.all([
    fileSha512Base64(response.body),
    fileSha512Base64(createReadStream(filePath)),
  ]);
  if (remoteHash !== localHash) return { ok: false, status: response.status };
  return { ok: true, etag, verifiedBy: "stream-sha512", sha256: await fileSha256Hex(filePath) };
}
