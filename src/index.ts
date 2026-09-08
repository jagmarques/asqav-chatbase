/**
 * Asqav proxy connector for Chatbase Custom Actions.
 *
 * Chatbase Custom Actions call a developer-defined HTTPS endpoint with the
 * variables the agent collected from the user, and expect a JSON response
 * (max 20KB). This connector is that endpoint. It signs the intended action
 * through Asqav before forwarding to the downstream URL. Explicit refusals
 * block forwarding. A configured transport fallback may forward without a receipt.
 *
 * The handler holds the real downstream credentials, so it first verifies an
 * operator-set shared secret on the inbound request. An unverified caller is
 * refused before anything is signed or forwarded, which stops the endpoint
 * from becoming a confused deputy for those credentials.
 *
 * Flow (verify-then-sign-then-forward = pre-execution gate):
 *   Chatbase  --secret-->  this handler  --sign-->  Asqav
 *                       |  unverified -> return { blocked: true, ... } (no sign, no forward)
 *                       |  allowed -> forward to downstream -> return its JSON
 *                       |  refused -> return { blocked: true, ... } (no forward)
 *
 * Cold-verified against the current Chatbase docs:
 *   - https://www.chatbase.co/docs/user-guides/chatbot/actions/custom-action
 *     A Custom (API) Action sends an HTTP request (GET/POST/PUT/DELETE) to a
 *     developer HTTPS endpoint. User-collected variables are injected into the
 *     URL or the JSON body. Custom headers are supported. The response must be
 *     JSON-formatted; the maximum response size is 20KB.
 *
 * Because Chatbase does not pin a fixed request schema (you choose method,
 * headers, and which variables travel), this handler is transport-agnostic:
 * it snapshots a JSON object for signing and body-bearing downstream requests.
 * GET and HEAD require an empty input object; inbound URL variables are not forwarded.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Agent } from "@asqav/sdk";

/** A framework-agnostic view of the inbound Chatbase request. Adapt your web
 * framework's request onto this shape (see `expressHandler` for Express). */
export interface ChatbaseRequest {
  /** The HTTP method Chatbase used for this action. */
  method?: string;
  /** Headers Chatbase sent (lower-cased keys recommended). */
  headers?: Record<string, string | string[] | undefined>;
  /** The parsed JSON body: the variables the agent collected from the user. */
  body?: unknown;
}

/** A framework-agnostic JSON response this handler produces. Serialize
 * `body` as JSON and write it with `status`. */
export interface ChatbaseResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface AsqavChatbaseOptions {
  /**
   * Pre-built Asqav `Agent`. Call `init()` and `Agent.create()` from
   * `@asqav/sdk` first, then pass the agent here.
   */
  agent: Agent;
  /**
   * The real downstream URL this action gates. When the sign is allowed, the
   * handler forwards the request here and returns the downstream JSON.
   */
  downstreamUrl: string;
  /**
   * The action name used on the signed receipt and as the Asqav action_type
   * suffix. Defaults to `"chatbase_action"`.
   */
  actionName?: string;
  /**
   * HTTP method used when forwarding to the downstream. Defaults to the
   * inbound method, or `"POST"` when none is present.
   */
  forwardMethod?: string;
  /**
   * Extra headers to send to the downstream (for example an auth token for
   * the real API). Merged over the forwarded content-type.
   */
  downstreamHeaders?: Record<string, string>;
  /**
   * Shared secret the inbound caller must present so the connector knows the
   * request is your Chatbase action and not a stranger who found the URL.
   * Falls back to `ASQAV_CHATBASE_INBOUND_SECRET`. REQUIRED: with no secret
   * the handler fails closed and forwards nothing, so this endpoint cannot be
   * deployed as an open confused deputy for your downstream credentials.
   */
  inboundSecret?: string;
  /**
   * Header that carries `inboundSecret`, looked up case-insensitively.
   * Defaults to `x-asqav-connector-secret`. Configure your Chatbase Custom
   * Action to send this header with the shared secret as its value.
   */
  inboundSecretHeader?: string;
  /**
   * Optional preflight before signing. When it returns `allowed: false`, the
   * action is blocked without signing a permit. Defaults to `agent.preflight`.
   */
  preflight?: (actionType: string, body: Record<string, unknown>) => Promise<GuardDecision> | GuardDecision;
  /**
   * When true (default), a signing transport error blocks the action
   * (fail-closed). A proxy connector sits on the action path, so the safe
   * default is to refuse when governance is unreachable. Set false to
   * forward only after an SDK network failure (APIError with statusCode 0).
   * HTTP responses and local signing refusals always block.
   */
  failClosed?: boolean;
  /** Error sink for signing transport errors. Defaults to `console.warn`. */
  onError?: (err: unknown, ctx: { actionName: string }) => void | Promise<void>;
  /** Injectable fetch for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  reasons?: string[];
}

function defaultOnError(err: unknown, ctx: { actionName: string }): void {
  // eslint-disable-next-line no-console
  console.warn(`[asqav/chatbase] sign failed for action '${ctx.actionName}':`, err);
}

function reportError(options: AsqavChatbaseOptions, err: unknown, actionName: string): void {
  try {
    const pending = (options.onError ?? defaultOnError)(err, { actionName });
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // An error sink cannot change the action decision or response.
  }
}

function isTransportError(err: unknown): boolean {
  // SDK module formats have different class identities; both expose these fields.
  return err instanceof Error && err.name === "APIError"
    && "statusCode" in err && err.statusCode === 0;
}

function snapshotInput(input: unknown): string {
  const value = input === undefined ? {} : input;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("input must be a JSON object");
  }
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (["undefined", "function", "symbol", "bigint"].includes(typeof item)
      || (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error("input contains a non-JSON value");
    }
    return item;
  });
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input must serialize to a JSON object");
  }
  return text;
}

async function downstreamResponse(response: Response, actionName: string): Promise<ChatbaseResponse> {
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  const body = json !== null && typeof json === "object" && !Array.isArray(json)
    ? json as Record<string, unknown> : { data: json };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 20_000) {
    return { status: 502, body: { blocked: false, error: "downstream_response_too_large", action: actionName } };
  }
  return { status: [204, 205, 304].includes(response.status) ? 200 : response.status, body };
}

/** Default header carrying the inbound shared secret. */
const DEFAULT_INBOUND_HEADER = "x-asqav-connector-secret";

/**
 * Read one request header case-insensitively. Returns the single string value,
 * or undefined when the header is absent or carries multiple values (an
 * ambiguous secret is treated as missing).
 */
function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = headers[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
      return value[0];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Constant-time secret comparison. Both sides are SHA-256 hashed first so the
 * compare is over fixed 32-byte digests: no length is leaked and the timing
 * does not depend on how many leading characters match.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Verify the inbound caller before anything is signed or forwarded. Returns a
 * rejection response when verification fails, or null when the caller may
 * proceed.
 *
 * Fail-closed by design: when no secret is configured (neither `inboundSecret`
 * nor `ASQAV_CHATBASE_INBOUND_SECRET`) every request is refused, so the
 * connector can never forward the operator's downstream credentials on behalf
 * of an unauthenticated caller (the confused-deputy hole).
 */
function verifyInbound(
  req: ChatbaseRequest,
  options: AsqavChatbaseOptions,
  actionName: string,
): ChatbaseResponse | null {
  const secret = options.inboundSecret ?? process.env.ASQAV_CHATBASE_INBOUND_SECRET;
  if (!secret) {
    reportError(options, new Error("inbound verification secret not configured"), actionName);
    return {
      status: 500,
      body: {
        blocked: true,
        action: actionName,
        error: "inbound_verification_unconfigured",
        message: "Asqav connector refuses to run: no inbound verification secret is configured",
      },
    };
  }
  const headerName = options.inboundSecretHeader ?? DEFAULT_INBOUND_HEADER;
  const provided = readHeader(req.headers, headerName);
  if (!provided || !secretsMatch(provided, secret)) {
    return {
      status: 401,
      body: {
        blocked: true,
        action: actionName,
        error: "inbound_verification_failed",
        message: `Asqav connector rejected action '${actionName}': inbound verification failed`,
      },
    };
  }
  return null;
}

async function runPreflight(
  opts: AsqavChatbaseOptions,
  actionType: string,
  body: Record<string, unknown>,
): Promise<{ allowed: boolean; reason: string }> {
  let decision: GuardDecision;
  if (opts.preflight) {
    decision = await opts.preflight(actionType, body);
  } else {
    const result = await opts.agent.preflight(actionType);
    decision = { allowed: result.cleared, reason: result.cleared ? undefined : result.explanation, reasons: result.reasons };
  }
  const allowed = decision?.allowed;
  if (typeof allowed !== "boolean") throw new Error("invalid preflight decision");
  const reason = allowed ? "" : decision.reason ?? (decision.reasons && decision.reasons.join("; ")) ?? "policy refused";
  if (typeof reason !== "string") throw new Error("invalid preflight refusal reason");
  return { allowed, reason };
}

/**
 * Handle one Chatbase Custom Action request: sign, then forward when allowed.
 * Returns the JSON response Chatbase should relay back to the agent.
 *
 * This is the core, framework-agnostic entry point. Use `expressHandler` for
 * a ready-made Express route, or call this directly from any serverless
 * function.
 */
export async function handleChatbaseAction(
  req: ChatbaseRequest,
  options: AsqavChatbaseOptions,
): Promise<ChatbaseResponse> {
  req = req ?? {};
  options = { ...options, downstreamHeaders: { ...options.downstreamHeaders } };
  const actionName = options.actionName ?? "chatbase_action";
  const actionType = `chatbase:action:${actionName}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Verify the inbound caller before any preflight, signing, or forward.
  //    An unverified caller is refused here and never reaches the downstream.
  const rejected = verifyInbound(req, options, actionName);
  if (rejected) return rejected;

  let bodyText: string;
  let method: string;
  try {
    method = (options.forwardMethod ?? req.method ?? "POST").toUpperCase();
    bodyText = snapshotInput(req.body);
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
      || (["GET", "HEAD"].includes(method) && Object.keys(JSON.parse(bodyText)).length > 0)) {
      throw new Error("unsupported method or nonempty GET/HEAD input");
    }
  } catch (err) {
    reportError(options, err, actionName);
    return { status: 400, body: { blocked: true, error: "invalid_input", action: actionName } };
  }

  // Optional preflight: a hard deny blocks before any permit signs.
  let pre: Awaited<ReturnType<typeof runPreflight>>;
  try {
    pre = await runPreflight(options, actionType, JSON.parse(bodyText));
  } catch (err) {
    reportError(options, err, actionName);
    return blockedResponse(actionName, "preflight unavailable");
  }

  // Sign the intended action. The receipt records what the agent tried,
  //    before the downstream runs.
  try {
    await options.agent.sign({
      actionType,
      context: { action_name: actionName, input: JSON.parse(bodyText) },
      policyDecision: pre.allowed ? "permit" : "deny",
      ...(pre.allowed ? {} : { reason: "policy_blocked" as const }),
    });
  } catch (err) {
    reportError(options, err, actionName);
    if (options.failClosed !== false || !isTransportError(err)) {
      return blockedResponse(actionName, "signing failed");
    }
    // fail-open: fall through and forward.
  }

  // Block: refused action never reaches the downstream.
  if (!pre.allowed) {
    return blockedResponse(actionName, pre.reason);
  }

  // Allowed: forward to the real downstream and relay its JSON.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.downstreamHeaders ?? {}),
  };
  const sendsBody = method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";

  try {
    const downstreamRes = await fetchImpl(options.downstreamUrl, {
      method,
      headers,
      body: sendsBody ? bodyText : undefined,
    });
    return await downstreamResponse(downstreamRes, actionName);
  } catch (err) {
    reportError(options, err, actionName);
    return {
      status: 502,
      body: { blocked: false, error: "downstream_unreachable", action: actionName },
    };
  }
}

/** The JSON returned when Asqav refuses the action. Chatbase relays this to
 * the agent so the model sees the block. */
function blockedResponse(actionName: string, reason: string): ChatbaseResponse {
  return {
    status: 403,
    body: {
      blocked: true,
      action: actionName,
      reason,
      message: `Asqav blocked action '${actionName}': ${reason}`,
    },
  };
}

/**
 * Minimal Express-style request/response contract. Declared locally so this
 * package has no `express` dependency; it structurally matches Express's
 * `Request`/`Response`.
 */
export interface MinimalExpressReq {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
export interface MinimalExpressRes {
  status(code: number): MinimalExpressRes;
  json(body: unknown): unknown;
}

/**
 * Build an Express route handler. Point a Chatbase Custom Action at the URL
 * this route is mounted on.
 *
 *   import express from "express";
 *   import { init, Agent } from "@asqav/sdk";
 *   import { expressHandler } from "asqav-chatbase";
 *
 *   init({ apiKey: process.env.ASQAV_API_KEY! });
 *   const agent = await Agent.create({ name: "chatbase-bot" });
 *
 *   const app = express();
 *   app.use(express.json());
 *   app.post("/asqav/refund", expressHandler({
 *     agent,
 *     actionName: "refund",
 *     downstreamUrl: "https://api.yourapp.com/refund",
 *     inboundSecret: process.env.ASQAV_CHATBASE_INBOUND_SECRET!,
 *   }));
 */
export function expressHandler(options: AsqavChatbaseOptions) {
  return async (req: MinimalExpressReq, res: MinimalExpressRes): Promise<void> => {
    const result = await handleChatbaseAction(
      {
        method: req.method,
        headers: req.headers,
        body: req.body,
      },
      options,
    );
    res.status(result.status).json(result.body);
  };
}
