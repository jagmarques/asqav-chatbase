import { describe, it, expect, vi } from "vitest";
import type { Agent } from "@asqav/sdk";
import { handleChatbaseAction, expressHandler } from "../src/index.js";

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

describe("handleChatbaseAction", () => {
  it("signs then forwards to the downstream when allowed", async () => {
    const { agent, sign } = mockAgent();
    const fetchImpl = okFetch({ refunded: 50 });

    const res = await handleChatbaseAction(
      { method: "POST", body: { orderId: "1234", amount: 50 } },
      { agent, actionName: "refund", downstreamUrl: "https://api.example.com/refund", fetchImpl },
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
      { method: "POST", body: { to: "acct" } },
      { agent, actionName: "wire", downstreamUrl: "https://api.example.com/wire", fetchImpl },
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
      { method: "POST", body: {} },
      { agent, actionName: "x", downstreamUrl: "https://api.example.com/x", fetchImpl, onError: vi.fn() },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.body.blocked).toBe(true);
  });

  it("returns 502 when the downstream is unreachable", async () => {
    const { agent } = mockAgent();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const res = await handleChatbaseAction(
      { method: "POST", body: {} },
      { agent, actionName: "x", downstreamUrl: "https://api.example.com/x", fetchImpl, onError: vi.fn() },
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("downstream_unreachable");
  });
});

describe("expressHandler", () => {
  it("writes the handler result onto the Express response", async () => {
    const { agent } = mockAgent();
    const fetchImpl = okFetch({ ok: true });
    const handler = expressHandler({ agent, actionName: "a", downstreamUrl: "https://api.example.com/a", fetchImpl });

    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json };

    await handler({ method: "POST", body: { x: 1 } }, res as never);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
