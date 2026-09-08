import { describe, it, expect, vi, afterEach } from "vitest";
import type { Agent } from "@asqav/sdk";
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
