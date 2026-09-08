import { describe, it, expect, vi, afterEach } from "vitest";
import type { Agent } from "@asqav/sdk";
import { Agent as SDKAgent, init, APIError, AuthenticationError, RateLimitError, AsqavResponseError } from "@asqav/sdk";
import { handleChatbaseAction, expressHandler } from "../src/index.js";

// Successful request fixtures carry this matching inbound header
const INBOUND_SECRET = "shared-inbound-secret";
const AUTH_HEADERS = { "x-asqav-connector-secret": INBOUND_SECRET };

function mockAgent(overrides: Partial<{ sign: ReturnType<typeof vi.fn>; preflight: ReturnType<typeof vi.fn> }> = {}) {
  const sign = overrides.sign ?? vi.fn().mockResolvedValue({ signatureId: "sig_1" });
  const preflight =
    overrides.preflight
    ?? vi.fn().mockResolvedValue({ cleared: true, agentActive: true, policyAllowed: true, reasons: [], explanation: "ok" });
  return { agent: { sign, preflight } as unknown as Agent, sign, preflight };
}

function okFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refusal and snapshot boundaries", () => {
  const request = { method: "POST", headers: AUTH_HEADERS, body: { amount: 1 } };
  function options(extra: Record<string, unknown> = {}) {
    return { agent: mockAgent().agent, downstreamUrl: "https://downstream.example/refund",
      inboundSecret: INBOUND_SECRET, fetchImpl: okFetch({ ok: true }), onError: vi.fn(), ...extra };
  }
  it.each([null, undefined])("refuses an absent request without throwing: %s", async request => {
    expect((await handleChatbaseAction(request as never, options())).status).toBe(401);
  });
  it.each([new APIError("forbidden", 403), new APIError("invalid", 422), new APIError("unavailable", 503),
    new AuthenticationError(), new RateLimitError(), new AsqavResponseError("invalid response"),
    new Error("local validation"), { name: "APIError", statusCode: 0 }])("blocks explicit/local refusal with fallback: %s", async error => {
    const agent = mockAgent({ sign: vi.fn().mockRejectedValue(error) }).agent;
    const opts = options({ agent, failClosed: false });
    const result = await handleChatbaseAction(request, opts);
    expect(result.status).toBe(403);
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([true, false])("restricts transport fallback to its explicit setting: %s", async failClosed => {
    const agent = mockAgent({ sign: vi.fn().mockRejectedValue(new APIError("Network error", 0)) }).agent;
    const opts = options({ agent, failClosed });
    const result = await handleChatbaseAction(request, opts);
    expect(result.status).toBe(failClosed ? 403 : 200);
    expect(opts.fetchImpl).toHaveBeenCalledTimes(failClosed ? 0 : 1);
  });
  it.each([null, {}, { allowed: "yes" }])("blocks a missing or nonboolean preflight result: %s", async decision => {
    const { agent, sign } = mockAgent();
    const opts = options({ agent, preflight: () => decision, failClosed: false });
    expect((await handleChatbaseAction(request, opts)).status).toBe(403);
    expect(sign).not.toHaveBeenCalled();
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it("blocks thrown preflight and contains synchronous and asynchronous error sinks", async () => {
    for (const onError of [() => { throw new Error("sink"); }, async () => { throw new Error("sink"); }]) {
      const opts = options({ preflight: () => { throw new Error("preflight"); }, onError, failClosed: false });
      expect((await handleChatbaseAction(request, opts)).status).toBe(403);
      expect(opts.fetchImpl).not.toHaveBeenCalled();
    }
    const opts = options({ fetchImpl: vi.fn().mockRejectedValue(new Error("downstream")), onError: () => { throw new Error("sink"); } });
    expect((await handleChatbaseAction(request, opts)).status).toBe(502);
  });
  it("uses the default error sink without changing an unconfigured refusal", async () => {
    vi.stubEnv("ASQAV_CHATBASE_INBOUND_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = options({ inboundSecret: undefined, onError: undefined });
    expect((await handleChatbaseAction(request, opts)).status).toBe(500);
    expect(warn).toHaveBeenCalledOnce();
  });
  it.each([null, [], "text", 1, { invalid: undefined }, { invalid: NaN }, { invalid: BigInt(1) },
    { invalid: () => 1 }, { invalid: Symbol("x") }, { toJSON: () => null }])("refuses non-object/non-JSON input: %s", async body => {
    const opts = options();
    expect((await handleChatbaseAction({ ...request, body }, opts)).status).toBe(400);
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses circular input and supports an omitted body", async () => {
    const body: Record<string, unknown> = {}; body.self = body;
    expect((await handleChatbaseAction({ ...request, body }, options())).status).toBe(400);
    const opts = options();
    expect((await handleChatbaseAction({ headers: AUTH_HEADERS }, opts)).status).toBe(200);
    expect(opts.fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST", body: "{}" }));
  });
  it.each(["GET", "HEAD", "TRACE", 42])("rejects unsupported or body-losing methods before signing: %s", async method => {
    const { agent, sign } = mockAgent();
    const opts = options({ agent });
    expect((await handleChatbaseAction({ ...request, method: method as string }, opts)).status).toBe(400);
    expect(sign).not.toHaveBeenCalled();
  });
  it.each(["get", "HEAD"])("allows an empty input for %s without a fetch body", async forwardMethod => {
    const opts = options({ forwardMethod });
    expect((await handleChatbaseAction({ ...request, body: {} }, opts)).status).toBe(200);
    expect(opts.fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: forwardMethod.toUpperCase(), body: undefined }));
  });
  it.each([[null, { data: null }], [[1], { data: [1] }], [true, { data: true }]])("returns an object for downstream JSON %s", async (input, expected) => {
    const result = await handleChatbaseAction(request, options({ fetchImpl: okFetch(input) }));
    expect(result.body).toEqual(expected);
  });
  it.each([204, 205, 304])("maps bodyless downstream status %s to JSON 200", async status => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
    expect(await handleChatbaseAction(request, options({ fetchImpl }))).toEqual({ status: 200, body: {} });
  });
  it("wraps non-JSON text and enforces the serialized UTF-8 response limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("plain", { status: 404 }));
    expect(await handleChatbaseAction(request, options({ fetchImpl }))).toEqual({ status: 404, body: { raw: "plain" } });
    for (const [text, status] of [["x".repeat(19989), 200], ["x".repeat(19990), 502], ["é".repeat(10000), 502]] as const) {
      expect((await handleChatbaseAction(request, options({ fetchImpl: okFetch({ text }) }))).status).toBe(status);
    }
  });
  it("accepts one header value and rejects an undefined header", async () => {
    expect((await handleChatbaseAction({ ...request, headers: { "X-Asqav-Connector-Secret": [INBOUND_SECRET] } }, options())).status).toBe(200);
    expect((await handleChatbaseAction({ ...request, headers: { "x-asqav-connector-secret": undefined } }, options())).status).toBe(401);
  });
  function realAgent() {
    init({ apiKey: "synthetic-key", baseUrl: "https://sdk.example/api/v1", mode: "full-payload" });
    return SDKAgent.attach({ agent_id: "synthetic-agent", name: "synthetic", public_key: "synthetic", key_id: "synthetic",
      algorithm: "ml-dsa-65", capabilities: [], created_at: "2026-09-08" });
  }
  it.each([
    { allowed: false, reason: "original refusal" },
    { allowed: false, reasons: ["original", "refusal"] },
    { allowed: true, reason: "unused" },
  ])("captures policy and refusal text before awaited signing: %s", async decision => {
    const initialAllowed = decision.allowed;
    const initialReason = decision.reason ?? decision.reasons?.join("; ");
    let signedDecision: unknown;
    const opts = options({ agent: realAgent(), preflight: () => decision });
    vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
      signedDecision = JSON.parse(request.body as string).policy_decision;
      decision.allowed = !initialAllowed;
      decision.reason = "changed refusal";
      decision.reasons?.splice(0, decision.reasons.length, "changed");
      return Response.json({ signature_id: "synthetic", action_id: "synthetic", verification_url: "https://verify.example/synthetic",
        signature: "synthetic", algorithm: "ml-dsa-65", timestamp: "2026-09-08" });
    });
    const result = await handleChatbaseAction(request, opts);
    expect(signedDecision).toBe(initialAllowed ? "permit" : "deny");
    expect(result.status).toBe(initialAllowed ? 200 : 403);
    expect(opts.fetchImpl).toHaveBeenCalledTimes(initialAllowed ? 1 : 0);
    if (!initialAllowed) expect(result.body.reason).toBe(initialReason);
  });
  it("reads a custom decision's allowed value once", async () => {
    let reads = 0;
    const decision = { get allowed() { reads += 1; return reads !== 1; }, reason: "refusal" };
    const opts = options({ preflight: () => decision });
    expect((await handleChatbaseAction(request, opts)).status).toBe(403);
    expect(reads).toBe(1);
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ allowed: false, reason: 42 }, { allowed: false, reasons: "invalid" }])("rejects invalid refusal text before signing: %s", async decision => {
    const { agent, sign } = mockAgent();
    const opts = options({ agent, preflight: () => decision });
    expect((await handleChatbaseAction(request, opts)).status).toBe(403);
    expect(sign).not.toHaveBeenCalled();
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it("blocks an actual released SDK HTTP403 despite explicit fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "forbidden" }, { status: 403 })));
    const opts = options({ agent: realAgent(), preflight: () => ({ allowed: true }), failClosed: false });
    expect((await handleChatbaseAction(request, opts)).status).toBe(403);
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it("recognizes the actual released SDK exhausted network failure", async () => {
    const sdkFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")); vi.stubGlobal("fetch", sdkFetch);
    const opts = options({ agent: realAgent(), preflight: () => ({ allowed: true }), failClosed: false });
    expect((await handleChatbaseAction(request, opts)).status).toBe(200);
    expect(sdkFetch).toHaveBeenCalledTimes(3);
    expect(opts.fetchImpl).toHaveBeenCalledOnce();
  });
  it("binds the actual SDK request to the forwarded snapshot despite caller and preflight mutation", async () => {
    const body = { amount: 1, nested: { value: 1 } };
    let signedInput: unknown;
    const opts = options({ agent: realAgent(), downstreamHeaders: { authorization: "original" },
      preflight: (_action: string, copy: typeof body) => { copy.amount = 7; copy.nested.value = 7; return { allowed: true }; } });
    vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
      signedInput = JSON.parse(request.body as string).context.input;
      body.amount = 2; body.nested.value = 2;
      opts.downstreamUrl = "https://changed.example";
      return Response.json({ signature_id: "synthetic", action_id: "synthetic", verification_url: "https://verify.example/synthetic",
        signature: "synthetic", algorithm: "ml-dsa-65", timestamp: "2026-09-08" });
    });
    expect((await handleChatbaseAction({ ...request, body }, opts)).status).toBe(200);
    expect(signedInput).toEqual({ amount: 1, nested: { value: 1 } });
    expect(opts.fetchImpl).toHaveBeenCalledWith("https://downstream.example/refund", expect.objectContaining({ body: JSON.stringify(signedInput) }));
    expect(body).toEqual({ amount: 2, nested: { value: 2 } });
  });
});

describe("handleChatbaseAction", () => {
  it("signs then forwards to the downstream when allowed", async () => {
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ refunded: 50 });

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: { orderId: "1234", amount: 50 } },
      { agent, actionName: "refund", downstreamUrl: "https://api.example.com/refund", fetchImpl, inboundSecret: INBOUND_SECRET },
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({
      actionType: "chatbase:action:refund",
      policyDecision: "permit",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/refund",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ orderId: "1234", amount: 50 }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refunded: 50 });
  });

  it("blocks and never forwards when preflight refuses", async () => {
    const preflight = vi
      .fn()
      .mockResolvedValue({ cleared: false, agentActive: false, policyAllowed: false, reasons: ["agent is revoked"], explanation: "agent is revoked" });
    const { agent, sign } = mockAgent({ preflight });
    const fetchImpl = okFetch({ should: "not happen" });

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: { to: "acct" } },
      { agent, actionName: "wire", downstreamUrl: "https://api.example.com/wire", fetchImpl, inboundSecret: INBOUND_SECRET },
    );

    expect(sign.mock.calls[0][0]).toMatchObject({ policyDecision: "deny", reason: "policy_blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.body.blocked).toBe(true);
  });

  it("fails closed by default when signing throws", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("network down"));
    const { agent } = mockAgent({ sign });
    const fetchImpl = okFetch({ should: "not happen" });

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: {} },
      { agent, actionName: "x", downstreamUrl: "https://api.example.com/x", fetchImpl, onError: vi.fn(), inboundSecret: INBOUND_SECRET },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.body.blocked).toBe(true);
  });

  it("returns 502 when the downstream is unreachable", async () => {
    const { agent } = mockAgent();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: {} },
      { agent, actionName: "x", downstreamUrl: "https://api.example.com/x", fetchImpl, onError: vi.fn(), inboundSecret: INBOUND_SECRET },
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("downstream_unreachable");
  });
});

describe("inbound verification (confused-deputy fix)", () => {
  it("rejects with 401 and never forwards when the secret header is missing", async () => {
    // A missing secret must block forwarding of the downstream credentials
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ refunded: 50 });

    const res = await handleChatbaseAction(
      { method: "POST", body: { orderId: "1234", amount: 50 } },
      { agent, actionName: "refund", downstreamUrl: "https://api.example.com/refund", fetchImpl, inboundSecret: INBOUND_SECRET, onError: vi.fn() },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.body.blocked).toBe(true);
    expect(res.body.error).toBe("inbound_verification_failed");
  });

  it("rejects with 401 and never forwards when the secret is wrong", async () => {
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ refunded: 50 });

    const res = await handleChatbaseAction(
      { method: "POST", headers: { "x-asqav-connector-secret": "wrong-secret" }, body: { amount: 50 } },
      { agent, actionName: "refund", downstreamUrl: "https://api.example.com/refund", fetchImpl, inboundSecret: INBOUND_SECRET, onError: vi.fn() },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("inbound_verification_failed");
  });

  it("forwards when the secret header matches", async () => {
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ refunded: 50 });

    const res = await handleChatbaseAction(
      { method: "POST", headers: { "x-asqav-connector-secret": INBOUND_SECRET }, body: { amount: 50 } },
      { agent, actionName: "refund", downstreamUrl: "https://api.example.com/refund", fetchImpl, inboundSecret: INBOUND_SECRET },
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refunded: 50 });
  });

  it("matches the secret header case-insensitively", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });

    const res = await handleChatbaseAction(
      { method: "POST", headers: { "X-Asqav-Connector-Secret": INBOUND_SECRET }, body: {} },
      { agent, downstreamUrl: "https://api.example.com/x", fetchImpl, inboundSecret: INBOUND_SECRET },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("honors a custom inboundSecretHeader", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });

    const res = await handleChatbaseAction(
      { method: "POST", headers: { "x-gate-token": INBOUND_SECRET }, body: {} },
      { agent, downstreamUrl: "https://api.example.com/x", fetchImpl, inboundSecret: INBOUND_SECRET, inboundSecretHeader: "x-gate-token" },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("rejects a multi-valued secret header as ambiguous", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });

    const res = await handleChatbaseAction(
      { method: "POST", headers: { "x-asqav-connector-secret": [INBOUND_SECRET, "other"] }, body: {} },
      { agent, downstreamUrl: "https://api.example.com/x", fetchImpl, inboundSecret: INBOUND_SECRET, onError: vi.fn() },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("fails closed with 500 and never signs or forwards when no secret is configured", async () => {
    // Missing configuration must refuse signing and forwarding
    vi.stubEnv("ASQAV_CHATBASE_INBOUND_SECRET", "");
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ should: "not happen" });

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: {} },
      { agent, downstreamUrl: "https://api.example.com/x", fetchImpl, onError: vi.fn() },
    );

    expect(sign).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("inbound_verification_unconfigured");
  });

  it("reads the secret from ASQAV_CHATBASE_INBOUND_SECRET when no option is set", async () => {
    vi.stubEnv("ASQAV_CHATBASE_INBOUND_SECRET", INBOUND_SECRET);
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });

    const res = await handleChatbaseAction(
      { method: "POST", headers: AUTH_HEADERS, body: {} },
      { agent, downstreamUrl: "https://api.example.com/x", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe("expressHandler", () => {
  it("writes the handler result onto the Express response", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });
    const handler = expressHandler({ agent, actionName: "a", downstreamUrl: "https://api.example.com/a", fetchImpl, inboundSecret: INBOUND_SECRET });

    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json };

    await handler({ method: "POST", headers: AUTH_HEADERS, body: { x: 1 } }, res as never);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it("rejects an unauthenticated request through the Express adapter", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });
    const handler = expressHandler({ agent, actionName: "a", downstreamUrl: "https://api.example.com/a", fetchImpl, inboundSecret: INBOUND_SECRET, onError: vi.fn() });

    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json };

    await handler({ method: "POST", body: { x: 1 } }, res as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
