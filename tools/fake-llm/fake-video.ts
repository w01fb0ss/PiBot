import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeVideoApi =
  | "openai-videos"
  | "gemini-veo"
  | "gemini-omni"
  | "kling"
  | "ark-seedance"
  | "agnes"
  | "openrouter-videos";
type Mode = "complete" | "hold" | "fail" | "oversize" | "private" | "legacy" | "inline" | "signed";
export const fakeAgnesModels = ["agnes-video-2.5", "agnes-video-2.5-flash"] as const;
export const fakeOpenRouterModel = "bytedance/seedance-2.0-mini";
type Task = { id: string; path: string; mode: Mode; polls: number; cancelled: boolean };
export const fakeVideoKey = (api: FakeVideoApi, builtin = false) =>
  api === "kling"
    ? "fake-kling-access:fake-kling-secret"
    : `fake-${builtin ? "builtin-" : ""}${api}-token`;
export const fakeVideoClip = () => readFile(new URL("./fixtures/solid-video.mp4", import.meta.url));
const cdnUrl = "https://fake-video-cdn.invalid/clip?signature=synthetic";

async function httpFixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handle(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function authenticated(api: FakeVideoApi, request: IncomingMessage, key: string) {
  if (api === "gemini-veo" || api === "gemini-omni")
    return request.headers["x-goog-api-key"] === key && !request.headers.authorization;
  if (api !== "kling") return request.headers.authorization === `Bearer ${key}`;
  const [head, payload, hash] =
    request.headers.authorization?.replace(/^Bearer /, "").split(".") ?? [];
  if (!head || !payload || !hash) return false;
  const [ak, sk] = fakeVideoKey(api).split(":") as [string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iss: string;
    nbf: number;
    exp: number;
  };
  const now = Date.now() / 1000;
  return (
    claims.iss === ak &&
    claims.nbf <= now &&
    claims.exp > now &&
    createHmac("sha256", sk).update(`${head}.${payload}`).digest("base64url") === hash
  );
}

const sendJson = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
};

export async function startFakeVideoCdn() {
  const clip = await fakeVideoClip();
  let reads = 0;
  let leaked = 0;
  const local = await httpFixture((request, response) => {
    if (request.url !== "/clip?signature=synthetic") return void response.writeHead(404).end();
    reads++;
    if (
      request.headers.authorization ||
      request.headers["x-goog-api-key"] ||
      request.headers.cookie
    )
      leaked++;
    response.writeHead(leaked ? 400 : 200, { "content-type": "video/mp4" }).end(clip);
  });
  return { ...local, expected: cdnUrl, reads: () => reads, leaked: () => leaked };
}

export async function startFakeVideo(api: FakeVideoApi, builtin = false) {
  const clip = await fakeVideoClip();
  const tasks: Task[] = [];
  const bodies: string[] = [];
  const modes: Mode[] = [];
  const queueStatuses: number[] = [];
  let queueFull = false;
  let holdProgress = false;
  let listSora = false;
  const key = fakeVideoKey(api, builtin);
  const routes = {
    "openai-videos": /^\/v1\/videos$/,
    "gemini-veo": /^\/v1beta\/models\/[A-Za-z0-9_.-]+:predictLongRunning$/,
    "gemini-omni": /^\/v1beta\/interactions$/,
    kling: /^\/v1\/videos\/(?:text2video|image2video)$/,
    "ark-seedance": /^\/api\/v3\/contents\/generations\/tasks$/,
    agnes: /^\/v1\/videos$/,
    "openrouter-videos": /^\/api\/v1\/videos$/,
  };
  const server = await httpFixture(async (request, response) => {
    const path = request.url ?? "";
    if (!authenticated(api, request, key)) return void response.writeHead(401).end();
    if (api === "agnes" && request.method === "GET" && path === "/v1/models")
      return sendJson(response, { data: fakeAgnesModels.map((id) => ({ id })) });
    if (api === "openrouter-videos" && request.method === "GET" && path === "/api/v1/videos/models")
      return sendJson(response, { data: [{ id: fakeOpenRouterModel }] });
    if (builtin && request.method === "GET" && path === "/v1/models")
      return sendJson(response, {
        data: [{ id: "gpt-test" }, ...(listSora ? [{ id: "sora-2" }] : [])],
      });
    if (builtin && request.method === "GET" && path.startsWith("/v1beta/models?"))
      return sendJson(
        response,
        path.includes("pageToken=")
          ? {
              models: [
                {
                  name: "models/veo-3.1-generate-preview",
                  supportedGenerationMethods: ["predictLongRunning"],
                },
                { name: "models/gemini-omni-1.2-flash" },
              ],
            }
          : {
              models: [
                { name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] },
              ],
              nextPageToken: "next",
            },
      );
    if (request.method === "POST" && routes[api].test(path)) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      bodies.push(body);
      const placeholderFrame =
        api === "openrouter-videos" &&
        JSON.parse(body).frame_images?.[0]?.image_url?.url === "https://example.com/";
      const mode = placeholderFrame ? "fail" : (modes[0] ?? "complete");
      if (api === "agnes" && queueFull) {
        const status = queueStatuses.length ? 200 : 429;
        queueStatuses.push(status);
        return sendJson(response, { code: "video_queue_full" }, status);
      }
      modes.shift();
      const id = `video-${tasks.length + 1}`;
      let pollingPath = `${path}/${id}`;
      if (api === "gemini-veo")
        pollingPath = `${path.replace(/:predictLongRunning$/, "")}/operations/${id}`;
      if (api === "gemini-omni") pollingPath = `/v1beta/files/${id}`;
      if (api === "agnes" && mode !== "legacy") {
        const { model } = JSON.parse(body) as { model: string };
        const query = new URLSearchParams({ video_id: id, model_name: model });
        pollingPath = `/agnesapi?${query}`;
      }
      const task = {
        id,
        path: pollingPath,
        mode,
        polls: 0,
        cancelled: false,
      };
      tasks.push(task);
      if (api === "openrouter-videos")
        return sendJson(
          response,
          { id, polling_url: server.url + pollingPath, status: "pending" },
          202,
        );
      if (api === "gemini-omni") {
        const { model, input } = JSON.parse(body) as { model: string; input: unknown };
        if (mode === "hold") {
          response.once("close", () => {
            task.cancelled = true;
          });
          return;
        }
        const uri = `https://generativelanguage.googleapis.com${pollingPath}:download?alt=media`;
        return sendJson(response, {
          steps: [
            {
              type: "user_input",
              content: typeof input === "string" ? [{ type: "text", text: input }] : input,
            },
            { type: "thought", content: [{ type: "thought", text: "Synthetic video plan" }] },
            {
              type: "model_output",
              content: [
                {
                  type: "video",
                  mime_type: "video/mp4",
                  ...(mode === "inline" ? { data: clip.toString("base64") } : { uri }),
                },
              ],
            },
          ],
          id: `v1_${id}`,
          status: "completed",
          model,
          object: "interaction",
        });
      }
      if (api === "agnes")
        return sendJson(response, {
          ...(mode === "legacy" ? { task_id: id } : { video_id: id, task_id: `task-${id}` }),
          status: "queued",
        });
      return sendJson(
        response,
        api === "gemini-veo"
          ? { name: pollingPath.slice(8) }
          : api === "kling"
            ? { code: 0, data: { task_id: id, task_status: "submitted" } }
            : { id, status: "queued" },
      );
    }
    const task = tasks.find(
      (item) =>
        path === item.path ||
        path === `${item.path}/content` ||
        (api === "openrouter-videos" &&
          (path === `${item.path}/content?index=0` || path === `${item.path}/signed`)) ||
        (api === "gemini-omni" && path === `${item.path}:download?alt=media`),
    );
    if (!task) return void response.writeHead(404).end();
    if (request.method === "DELETE") {
      task.cancelled = true;
      return sendJson(response, { id: task.id, deleted: true });
    }
    if (request.method !== "GET") return void response.writeHead(405).end();
    if (api === "openrouter-videos") {
      if (path === `${task.path}/content?index=0`)
        return void response.writeHead(200, { "content-type": "video/mp4" }).end(clip);
      if (path === `${task.path}/signed`)
        return void response.writeHead(302, { location: cdnUrl }).end();
      const polling_url = server.url + task.path;
      const job = { id: task.id, generation_id: `gen-${task.id}`, polling_url };
      if (++task.polls === 1)
        return sendJson(response, { ...job, status: "in_progress", status_detail: "generating" });
      if (task.mode === "fail")
        return sendJson(response, {
          ...job,
          status: "failed",
          error: { code: 422, message: "Synthetic first frame is unreadable" },
        });
      return sendJson(response, {
        ...job,
        status: "completed",
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        ...(task.mode !== "signed" && { unsigned_urls: [`${polling_url}/content?index=0`] }),
        urls: [`${polling_url}/signed`],
        usage: { cost: 0.142079, is_byok: false },
      });
    }
    if (api === "gemini-omni") {
      if (path !== task.path) {
        if (task.polls < 2) return void response.writeHead(409).end();
        return void response.writeHead(200, { "content-type": "video/mp4" }).end(clip);
      }
      return sendJson(response, {
        name: `files/${task.id}`,
        mimeType: "video/mp4",
        state: ++task.polls >= 2 ? "ACTIVE" : "PROCESSING",
      });
    }
    if (path.endsWith("/content")) {
      if (task.mode === "oversize")
        return void response.writeHead(200, { "content-length": 21 * 1024 * 1024 }).end();
      if (task.mode === "private")
        return void response.writeHead(302, { location: "https://127.0.0.1/clip" }).end();
      if (task.id === "video-1") return void response.writeHead(302, { location: cdnUrl }).end();
      return void response.writeHead(200, { "content-type": "video/mp4" }).end(clip);
    }
    const complete = ++task.polls >= 4 && task.mode !== "hold" && !holdProgress;
    const failed = complete && task.mode === "fail";
    if (api === "openai-videos")
      return sendJson(response, {
        id: task.id,
        progress: complete ? 100 : 20,
        status: failed ? "failed" : complete ? "completed" : "in_progress",
      });
    if (api === "gemini-veo")
      return sendJson(response, {
        done: complete,
        ...(failed
          ? { error: { code: 13 } }
          : complete
            ? {
                response: {
                  generateVideoResponse: { generatedSamples: [{ video: { uri: cdnUrl } }] },
                },
              }
            : {}),
      });
    if (api === "kling")
      return sendJson(response, {
        code: 0,
        data: {
          task_id: task.id,
          task_status: failed ? "failed" : complete ? "succeed" : "processing",
          ...(complete && !failed ? { task_result: { videos: [{ url: cdnUrl }] } } : {}),
        },
      });
    if (api === "agnes")
      return sendJson(response, {
        status: failed ? "failed" : complete ? "completed" : "in_progress",
        progress: complete ? 100 : 20,
        ...(complete && !failed ? { [task.mode === "legacy" ? "url" : "video_url"]: cdnUrl } : {}),
      });
    return sendJson(response, {
      id: task.id,
      status: failed ? "failed" : complete ? "succeeded" : "running",
      ...(complete && !failed ? { content: { video_url: cdnUrl } } : {}),
    });
  });
  return {
    ...server,
    tasks,
    bodies,
    queueStatuses,
    listSora: (listed = true) => {
      listSora = listed;
    },
    setQueueFull: (full: boolean) => {
      queueFull = full;
    },
    setHoldProgress: (hold: boolean) => {
      holdProgress = hold;
    },
    next: (mode: Mode) => modes.push(mode),
  };
}
