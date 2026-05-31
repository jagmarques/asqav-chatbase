/**
 * Asqav proxy connector for Chatbase Custom Actions.
 *
 * Chatbase Custom Actions call a developer-defined HTTPS endpoint with the
 * variables the agent collected from the user, and expect a JSON response
 * (max 20KB). This connector is that endpoint. It signs the intended action
 * through Asqav before anything runs, and only then forwards the call to the
 * real downstream URL. If Asqav refuses, the downstream is never called and a
 * blocked JSON response is returned: stop a rogue agent before it acts, and
 * prove what it tried.
 *
 * Flow (sign-then-forward = pre-execution gate):
 *   Chatbase  ->  this handler  --sign-->  Asqav
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
 * it signs whatever JSON body arrives and forwards it verbatim to the
 * configured downstream.
 */

import { Agent } from "@asqav/sdk";

/** A framework-agnostic view of the inbound Chatbase request. Adapt your web
 * framework's request onto this shape (see `expressHandler` for Express). */
export interface ChatbaseRequest {
  /** The HTTP method Chatbase used for this action. */
  method?: string;
  /** Headers Chatbase sent (lower-cased keys recommended). */
  headers?: Record<string, string | string[] | undefined>;
  /** The parsed JSON body: the variables the agent collected from the user. */
  body?: Record<string, unknown>;
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
   * Optional preflight before signing. When it returns `allowed: false`, the
   * action is blocked without signing a permit. Defaults to `agent.preflight`.
   */
  preflight?: (actionType: string, body: Record<string, unknown>) => Promise<GuardDecision> | GuardDecision;
  /**
   * When true (default), a signing transport error blocks the action
   * (fail-closed). A proxy connector sits on the action path, so the safe
   * default is to refuse when governance is unreachable. Set false to
   * fail-open and forward anyway.
   */
  failClosed?: boolean;
  /** Error sink for signing transport errors. Defaults to `console.warn`. */
  onError?: (err: unknown, ctx: { actionName: string }) => void;
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

async function runPreflight(
  opts: AsqavChatbaseOptions,
  actionType: string,
  body: Record<string, unknown>,
): Promise<GuardDecision> {
  if (opts.preflight) {
    return opts.preflight(actionType, body);
  }
  try {
    const result = await opts.agent.preflight(actionType);
    return {
      allowed: result.cleared,
      reason: result.cleared ? undefined : result.explanation,
      reasons: result.reasons,
    };
  } catch {
    return { allowed: true };
  }
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
  const actionName = options.actionName ?? "chatbase_action";
  const actionType = `chatbase:action:${actionName}`;
  const body = req.body ?? {};
  const onError = options.onError ?? defaultOnError;
  const fetchImpl = options.fetchImpl ?? fetch;
  const failClosed = options.failClosed !== false;

  // 1. Optional preflight: a hard deny blocks before any permit signs.
  const pre = await runPreflight(options, actionType, body);

  // 2. Sign the intended action. The receipt records what the agent tried,
  //    before the downstream runs.
  try {
    await options.agent.sign({
      actionType,
      context: { action_name: actionName, input: body },
      policyDecision: pre.allowed ? "permit" : "deny",
      ...(pre.allowed ? {} : { reason: "policy_blocked" as const }),
    });
  } catch (err) {
    onError(err, { actionName });
    if (failClosed) {
      return blockedResponse(actionName, "signing unavailable (fail-closed)");
    }
    // fail-open: fall through and forward.
  }

  // 3. Block: refused action never reaches the downstream.
  if (!pre.allowed) {
    const reason = pre.reason ?? (pre.reasons && pre.reasons.join("; ")) ?? "policy refused";
    return blockedResponse(actionName, reason);
  }

  // 4. Allowed: forward to the real downstream and relay its JSON.
  const method = options.forwardMethod ?? req.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.downstreamHeaders ?? {}),
  };
  const sendsBody = method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";

  try {
    const downstreamRes = await fetchImpl(options.downstreamUrl, {
      method,
      headers,
      body: sendsBody ? JSON.stringify(body) : undefined,
    });
    const text = await downstreamRes.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Chatbase requires JSON; wrap a non-JSON downstream body.
      json = { raw: text };
    }
    return { status: downstreamRes.status, body: json };
  } catch (err) {
    onError(err, { actionName });
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
 *   }));
 */
export function expressHandler(options: AsqavChatbaseOptions) {
  return async (req: MinimalExpressReq, res: MinimalExpressRes): Promise<void> => {
    const result = await handleChatbaseAction(
      {
        method: req.method,
        headers: req.headers,
        body: (req.body ?? {}) as Record<string, unknown>,
      },
      options,
    );
    res.status(result.status).json(result.body);
  };
}
