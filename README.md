<p align="center">
  <a href="https://asqav.com"><img src="https://asqav.com/logo-text-white.png" alt="Asqav" width="150"></a>
</p>

# asqav-chatbase

Stop a rogue agent before it acts, and prove what it tried. This package is a proxy connector for [Chatbase](https://www.chatbase.co) Custom Actions. Point a Chatbase Custom Action at it, and it signs the intended action through Asqav before forwarding to your real API. If Asqav refuses, the downstream is never called and the connector returns a blocked JSON response. Every attempt becomes a tamper-evident receipt, signed server-side with NIST FIPS 204 ML-DSA-65. The agent never holds the signing key, so it cannot forge the record.

This is a sign-then-forward pre-execution gate. Signing happens before the downstream runs, so a refused action never executes.

## How it hooks in

A Chatbase Custom API Action sends an HTTP request, with a method of GET, POST, PUT, or DELETE, to a developer-defined HTTPS endpoint, injecting the variables the agent collected from the user into the URL or the JSON body. Custom headers are supported, and the endpoint must return JSON up to 20KB. This connector is that endpoint: it signs the inbound action and, when allowed, forwards the same body to your real downstream URL and relays its JSON back to Chatbase.

```
Chatbase  ->  this handler  --sign-->  Asqav
                    |  allowed  -> forward to your real API -> relay JSON
                    |  refused  -> return { blocked: true, ... } (no forward)
```

Reference, cold-verified: [Chatbase Custom Action docs](https://www.chatbase.co/docs/user-guides/chatbot/actions/custom-action).

## Install

Not yet published to npm. Install from GitHub or a local path:

```bash
npm install github:jagmarques/asqav-chatbase
```

```json
{
  "dependencies": {
    "asqav-chatbase": "file:../asqav-chatbase",
    "@asqav/sdk": "^0.5.5"
  }
}
```

## Quick start with Express

```ts
import express from "express";
import { init, Agent } from "@asqav/sdk";
import { expressHandler } from "asqav-chatbase";

init({ apiKey: process.env.ASQAV_API_KEY! });
const agent = await Agent.create({ name: "chatbase-bot" });

const app = express();
app.use(express.json());

// Mount one route per gated action.
app.post("/asqav/refund", expressHandler({
  agent,
  actionName: "refund",
  downstreamUrl: "https://api.yourapp.com/refund",
  // headers sent to YOUR real API (not to Chatbase)
  downstreamHeaders: { authorization: `Bearer ${process.env.YOURAPP_TOKEN}` },
}));

app.listen(3000);
```

## Point Chatbase at it

1. In your Chatbase agent, add a Custom API Action.
2. Set the action URL to your deployed handler, for example `https://gate.yourapp.com/asqav/refund`.
3. Set the method to `POST` and define the variables the agent collects from the user. They arrive in the JSON body.
4. The handler signs the action, forwards the body to `downstreamUrl`, and returns the downstream JSON. A refused action returns `{ "blocked": true, ... }` so the agent sees the block.

## Serverless with any framework

Use the framework-agnostic core directly:

```ts
import { handleChatbaseAction } from "asqav-chatbase";

export async function POST(request: Request) {
  const body = await request.json();
  const result = await handleChatbaseAction(
    { method: "POST", body },
    { agent, actionName: "refund", downstreamUrl: "https://api.yourapp.com/refund" },
  );
  return new Response(JSON.stringify(result.body), { status: result.status });
}
```

## Options

`handleChatbaseAction(req, options)` and `expressHandler(options)` accept:

- `agent`, required: a pre-built Asqav `Agent` from `@asqav/sdk`.
- `downstreamUrl`, required: your real API this action gates.
- `actionName`: the name on the signed receipt and the action_type suffix. Defaults to `"chatbase_action"`.
- `forwardMethod`: method used when forwarding. Defaults to the inbound method, or `POST`.
- `downstreamHeaders`: extra headers sent to your downstream, such as an auth token.
- `preflight`: a custom `(actionType, body) => { allowed, reason }` check. Defaults to `agent.preflight`.
- `failClosed`, defaulting to `true`: block the action when a signing transport error occurs. A proxy connector sits on the action path, so the safe default is to refuse when governance is unreachable. Set `false` to fail-open.
- `onError`: sink for signing transport errors. Defaults to `console.warn`.

## License

MIT
