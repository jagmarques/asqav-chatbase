# asqav-chatbase

Gate a Chatbase Server Custom Action through an Asqav Agent before forwarding its JSON input to your API. The connector checks an inbound shared secret, runs preflight and attempts signing. An explicit refusal blocks forwarding. Only actions routed through this endpoint are covered.

A successful signing call records intent before execution. The connector does not attest the downstream result or verify a signature locally. Rejected input, authentication failures and unavailable signing can produce no receipt. The optional transport fallback can execute without a receipt.

## Install from a local checkout

Use Node 22.12 or a later Node 22 release for the source build. The package uses the released SDK range `^0.10.10`; its runtime requires Node 20.19 through 20.x, or Node 22.12 and later.

Place this checkout beside your application directory as `asqav-chatbase`. Run these commands from your application directory:

```sh
npm ci --prefix ../asqav-chatbase
npm install ../asqav-chatbase
npm install express @asqav/sdk@^0.10.10
```

## Configure one Agent

Set `ASQAV_API_KEY`, `ASQAV_AGENT_ID`, `ASQAV_CHATBASE_INBOUND_SECRET` and `YOURAPP_TOKEN` in your server environment. Use an existing Agent ID from Asqav. The inbound secret is a separate shared value you also configure in Chatbase; keep the Asqav key and downstream token on your server.

Save this as `agent.mjs`:

```js
import { init, Agent } from "@asqav/sdk";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export const inboundSecret = required("ASQAV_CHATBASE_INBOUND_SECRET");
export const downstreamToken = required("YOURAPP_TOKEN");
init({ apiKey: required("ASQAV_API_KEY"), mode: "full-payload" });
export const agent = await Agent.get(required("ASQAV_AGENT_ID"));
```

SDK 0.10.10 uses module-wide connection configuration. Keep one API key/base/mode configuration per process and do not call `init()` for another tenant or during requests. This connector accepts a prebuilt Agent; it does not provide connection isolation.

## Express

Save this as `server.mjs`, then run `node server.mjs`:

```js
import express from "express";
import { expressHandler } from "asqav-chatbase";
import { agent, inboundSecret, downstreamToken } from "./agent.mjs";

const app = express();
app.use(express.json());
app.post("/asqav/refund", (req, res, next) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "json_required" });
  next();
}, expressHandler({
  agent, inboundSecret, actionName: "refund",
  downstreamUrl: "https://api.yourapp.com/refund",
  downstreamHeaders: { authorization: `Bearer ${downstreamToken}` },
}));
app.use((err, req, res, next) => {
  const status = err.type === "entity.parse.failed" ? 400 : err.status === 413 ? 413 : 500;
  res.status(status).json({ error: "request_failed" });
});
app.listen(3000);
```

In Chatbase, choose a **Server** Custom Action and your deployed HTTPS `/asqav/refund` endpoint. Use POST with a JSON object body containing the action variables. Set `Content-Type: application/json` and give `x-asqav-connector-secret` the same inbound secret. A custom `inboundSecretHeader` must also be configured with that exact name in Chatbase. Test a wrong-secret request and a refused action as well as a successful request.

Chatbase documents configured headers and JSON requests/responses, with a 20KB response limit. This connector uses a conservative 20,000-byte limit on its serialized downstream response. The actual Chatbase account/workflow still needs your end-to-end test. [Custom Action documentation](https://www.chatbase.co/docs/user-guides/chatbot/actions/custom-action).

## Serverless POST handler

Reuse the defined Agent configuration above; forward the incoming headers to the core:

```js
import { handleChatbaseAction } from "asqav-chatbase";
import { agent, inboundSecret, downstreamToken } from "./agent.mjs";

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const result = await handleChatbaseAction(
    { method: request.method, headers: Object.fromEntries(request.headers), body },
    { agent, inboundSecret, actionName: "refund",
      downstreamUrl: "https://api.yourapp.com/refund",
      downstreamHeaders: { authorization: `Bearer ${downstreamToken}` } },
  );
  return Response.json(result.body, { status: result.status });
}
```

## Behavior and options

`handleChatbaseAction(req, options)` and `expressHandler(options)` require `agent` and `downstreamUrl`. `actionName` defaults to `chatbase_action`; the signing action type is `chatbase:action:<name>`.

`inboundSecret` defaults to `ASQAV_CHATBASE_INBOUND_SECRET`. Missing configuration returns 500; a missing, wrong or ambiguous secret header returns 401 before preflight/signing/forwarding. `inboundSecretHeader` defaults to `x-asqav-connector-secret` and is matched without case sensitivity. Incoming headers are not forwarded to your API; `downstreamHeaders` supplies its configured headers.

The input must be a JSON object; an omitted body means `{}`. The connector serializes it before awaiting anything and gives custom preflight a separate copy. Caller or preflight mutations cannot change the snapshot used for signing and forwarding. Serialization errors and non-JSON values return 400. Configure only trusted SDK hooks: they can affect the signing context.

`forwardMethod` overrides the incoming method, which defaults to POST. POST, PUT, PATCH, DELETE and OPTIONS forward the JSON snapshot. GET and HEAD require empty input and send no body. Incoming URL/query variables are not copied into `downstreamUrl`; configure action variables in the JSON body. The receipt input does not attest method, headers or the destination URL.

`preflight(actionType, body)` can supply `{ allowed, reason?, reasons? }`; otherwise the connector uses `agent.preflight`. The connector captures the decision and refusal text before awaiting signing. A refusal attempts a deny receipt and blocks execution. A thrown preflight or missing/nonboolean `allowed` value blocks without attempting a permit. `failClosed` defaults to true. Setting it to false permits forwarding after a positive preflight only when signing throws the SDK's network `APIError` with `statusCode: 0`. HTTP responses (including 401/403/429/5xx), local validation errors and malformed signing responses still block. A network failure can leave receipt creation uncertain; do not interpret fallback as authorization.

`onError(error, { actionName })` receives operational errors and defaults to `console.warn`; thrown or rejected error-sink callbacks do not change the action decision. `fetchImpl` overrides downstream fetch only. SDK traffic uses the SDK's own fetch.

Downstream object JSON is returned directly; arrays, scalars and null become `{ data: ... }`, and non-JSON text becomes `{ raw: ... }`. Empty responses become `{}`; statuses 204/205/304 become 200 so JSON can be returned. Other downstream statuses are retained. Unreachable downstream or oversized serialized output returns 502 with `blocked: false`: signing/preflight allowed forwarding, but the downstream action may already have occurred. The connector does not retry that action or provide idempotency.

The example's full-payload mode sends `action_name` and the captured `input` to Asqav. SDK hash-only mode sends its computed digest and permitted metadata instead; the full JSON still goes to your downstream API. Neither inbound secret nor downstream headers enters the signing context unless your own body/hooks include them. Signing has no downstream response to include.

## License

[Elastic License 2.0](LICENSE), as specified by this repository's existing terms.
