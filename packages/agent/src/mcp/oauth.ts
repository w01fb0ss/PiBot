import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import {
  auth,
  type OAuthClientProvider,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  ConnectorAuthenticationError,
  type ConnectorOAuthAuthorization,
  type ConnectorOAuthStorage,
} from "@pibot/protocol-base";
import { z } from "zod";

const tokensSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .catchall(z.json());
const clientSchema = z
  .object({ client_id: z.string().min(1), client_secret: z.string().optional() })
  .catchall(z.json());
const stateSchema = z.strictObject({
  client: clientSchema.optional(),
  tokens: tokensSchema.optional(),
  verifier: z.string().optional(),
  redirectUrl: z.url().optional(),
  discovery: z.record(z.string(), z.json()).optional(),
});
type State = z.output<typeof stateSchema>;

/** The single encrypted blob includes client credentials, tokens and the current PKCE verifier. */
export async function createConnectorOAuthProvider(
  storage: ConnectorOAuthStorage,
  interactive?: {
    redirectUrl: string;
    state: string;
    open(url: string): Promise<void>;
    fresh?: boolean;
  },
): Promise<OAuthClientProvider> {
  let state: State = {};
  const raw = await storage.load();
  if (raw !== undefined) {
    try {
      state = stateSchema.parse(JSON.parse(raw));
    } catch {
      throw new ConnectorAuthenticationError();
    }
  }
  if (interactive && (interactive.fresh || state.redirectUrl !== interactive.redirectUrl)) {
    // Dynamic registration is bound to its redirect URI; a fresh random port or an explicit
    // re-authorization consent flow must start without reusing cached tokens.
    delete state.client;
    delete state.tokens;
    delete state.discovery;
    delete state.verifier;
  }
  const save = async () => storage.save(JSON.stringify(state));
  // Interactive authorization (including fresh re-authorization while already signed in) keeps
  // intermediate discovery, dynamic client registration and PKCE verifier in memory until new
  // tokens are issued, so cancelling or declining never clobbers a working saved login.
  const persistIntermediate = async () => {
    if (!interactive) await save();
  };
  return {
    redirectUrl: interactive?.redirectUrl ?? state.redirectUrl,
    clientMetadata: {
      client_name: "Pi Bot",
      redirect_uris: [
        interactive?.redirectUrl ?? state.redirectUrl ?? "http://127.0.0.1/oauth/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => interactive?.state ?? "",
    clientInformation: () =>
      state.client as Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>,
    async saveClientInformation(client) {
      state.client = clientSchema.parse(client);
      await persistIntermediate();
    },
    tokens: () => state.tokens as Awaited<ReturnType<OAuthClientProvider["tokens"]>>,
    async saveTokens(tokens) {
      state.tokens = tokensSchema.parse(tokens);
      state.redirectUrl = interactive?.redirectUrl ?? state.redirectUrl;
      delete state.verifier;
      await save();
    },
    async saveCodeVerifier(verifier) {
      state.verifier = verifier;
      state.redirectUrl = interactive?.redirectUrl ?? state.redirectUrl;
      await persistIntermediate();
    },
    codeVerifier() {
      if (!state.verifier) throw new ConnectorAuthenticationError();
      return state.verifier;
    },
    discoveryState: () =>
      state.discovery as Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>,
    async saveDiscoveryState(discovery) {
      state.discovery = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(discovery)));
      await persistIntermediate();
    },
    async redirectToAuthorization(url) {
      if (!interactive || url.protocol !== "https:") throw new ConnectorAuthenticationError();
      await interactive.open(url.toString());
    },
    async invalidateCredentials(scope) {
      if (scope === "all") state = {};
      if (scope === "client") delete state.client;
      if (scope === "tokens") delete state.tokens;
      if (scope === "verifier") delete state.verifier;
      if (scope === "discovery") delete state.discovery;
      await persistIntermediate();
    },
  };
}

export function connectorAuthError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  return (
    error instanceof ConnectorAuthenticationError ||
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) ||
    ("cause" in error && connectorAuthError(error.cause, seen))
  );
}

/** Explicit user action owns the loopback listener; no browser is opened by an agent call. */
export async function authorizeConnectorOAuth(
  input: ConnectorOAuthAuthorization,
  networkFetch: typeof fetch = fetch,
): Promise<void> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60_000)]);
  signal.throwIfAborted();
  const expectedState = randomBytes(32).toString("base64url");
  let callbackResponse: ServerResponse | undefined;
  let resolveCode: (value: { code: string; iss?: string }) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Observe cancellation while discovery/registration are still in progress.
  void code.catch(() => undefined);
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const address = server.address();
    const origin = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
    const url = new URL(req.url ?? "/", `http://${origin}`);
    const receivedState = url.searchParams.get("state") ?? "";
    const validState =
      Buffer.byteLength(receivedState) === Buffer.byteLength(expectedState) &&
      timingSafeEqual(Buffer.from(receivedState), Buffer.from(expectedState));
    if (
      req.method !== "GET" ||
      req.headers.host !== origin ||
      url.pathname !== "/oauth/callback" ||
      !validState
    ) {
      res.statusCode = 400;
      res.end(oauthErrorHtml("Authorization could not be verified."));
      return;
    }
    const value = url.searchParams.get("code");
    if (url.searchParams.has("error") || !value || value.length > 8192) {
      res.statusCode = 400;
      res.end(oauthErrorHtml("Authorization was declined."));
      rejectCode(new ConnectorAuthenticationError());
      return;
    }
    if (callbackResponse) {
      res.statusCode = 409;
      res.end(oauthErrorHtml("Authorization is already being processed."));
      return;
    }
    callbackResponse = res;
    resolveCode({
      code: value,
      ...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss") ?? undefined } : {}),
    });
  });
  const cancel = () => rejectCode(new DOMException("Authorization cancelled", "AbortError"));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new ConnectorAuthenticationError();
    const provider = await createConnectorOAuthProvider(input.storage, {
      redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
      state: expectedState,
      open: input.openExternal,
      fresh: input.fresh,
    });
    const fetchFn: typeof fetch = (url, init) =>
      networkFetch(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      });
    const result = await auth(provider, { serverUrl: input.url, fetchFn });
    if (result === "AUTHORIZED") return;
    const callback = await code;
    signal.throwIfAborted();
    if (
      (await auth(provider, {
        serverUrl: input.url,
        authorizationCode: callback.code,
        iss: callback.iss,
        fetchFn,
      })) !== "AUTHORIZED"
    )
      throw new ConnectorAuthenticationError();
    callbackResponse?.end(oauthSuccessHtml("You can return to Pi Bot."));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ConnectorAuthenticationError) throw error;
    throw new ConnectorAuthenticationError();
  } finally {
    if (callbackResponse && !callbackResponse.writableEnded) {
      callbackResponse.statusCode = 400;
      callbackResponse.end(
        oauthErrorHtml("Authorization could not be completed. Return to Pi Bot to try again."),
      );
    }
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
