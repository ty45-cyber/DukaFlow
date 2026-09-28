# DukaFlow Final — UX-First Verified Voice Commerce

DukaFlow is a competition-ready demonstration of **evidence-gated voice procurement** built around AssemblyAI's Voice Agent API.

> **AssemblyAI handles conversation. DukaFlow handles truth.**

## Product in one glance

The interface deliberately teaches the product before the user has to think:

**SAY IT → WE CHECK IT → YOU CONFIRM**

The dominant action is **Tap to talk**. The transaction workspace then mirrors the mental model of the user: what was heard, what is true right now, and what still requires authorization.

## UX-first upgrades in this build

- **First-glance comprehension:** the home screen explains the workflow in three words and one primary action.
- **60-second guided walkthrough:** judges can experience the core transaction without configuring a microphone or AssemblyAI first.
- **Live verification panel:** catalog match, stock, current price and delivery state become visible before execution.
- **Evidence gate as a product surface:** the five consequential checks (product, variant, quantity, destination, authorization) are always visible.
- **Safe refusal is visible:** ambiguous catalog matches are presented as a blocked state rather than hidden inside the conversation.
- **Explicit execution boundary:** order creation is visibly separate from payment; payment is labelled sandbox-only.
- **Operational proof:** merchant metrics, recent orders and the event trail make the backend state inspectable.
- **Responsive mobile layout:** the primary journey remains usable on narrow screens.

## Live voice path

1. Click **Tap to talk**.
2. Speak naturally, for example: `I need three SunGold Cooking Oil 3L. Deliver to Westlands.`
3. The AssemblyAI agent uses tools for catalog, inventory and pricing.
4. The UI shows the resolved transaction and evidence status.
5. Say an explicit confirmation such as `Yes, place the order.`
6. The server validates evidence, applies the deterministic order transition and reserves inventory.
7. A separate sandbox payment request can then be created.

## Guided walkthrough

Click **Run 60-sec walkthrough** to execute the same core path without voice hardware:

- customer request
- product resolution
- live stock check
- current cart calculation
- explicit confirmation
- server-side evidence gate
- inventory reservation
- sandbox payment request

The walkthrough intentionally stops before payment confirmation so the payment boundary remains visible.

## Domain guarantees

The domain layer remains authoritative for:

- catalog resolution
- inventory validation
- current pricing and delivery calculation
- evidence requirements
- explicit confirmation
- deterministic order state transitions
- idempotency
- inventory reservation
- sandbox payment lifecycle

The LLM is an interface to that domain, not the source of truth.

## Run locally

Requirements: Node.js 20+ and a modern browser.

```bash
cp .env.example .env
# Add ASSEMBLYAI_API_KEY for live voice
node src/server.mjs
```

Open `http://localhost:3000`.

Run tests:

```bash
npm test
npm run check
```

No npm dependencies are required.

## Production hardening roadmap

For production, move the JSON store to PostgreSQL with row-level/serializable transaction semantics, enforce authenticated merchant/customer principals, persist transcript provenance server-side, integrate Safaricom Daraja behind a `PaymentProvider` boundary, validate webhooks cryptographically, expire reservations, add rate limits and structured observability, and add customer-specific order memory with explicit authorization boundaries.

## Competition framing

DukaFlow is not positioned as “another voice chatbot.” The product thesis is:

> **A voice procurement layer for repeat business purchases: remember the order, revalidate today's reality, and execute only when the evidence is sufficient.**

The strongest demo moment is deliberately not the happy path alone. It is the visible refusal when the system cannot safely resolve a purchase.

## References

AssemblyAI Voice Agent browser integration and temporary tokens: https://www.assemblyai.com/blog/build-a-voice-assistant-app-with-voice-agent-api

AssemblyAI Voice Agent tool calling and event sequencing: https://www.assemblyai.com/blog/how-to-build-with-voice-agent-api

AssemblyAI raw WebSocket protocol: https://www.assemblyai.com/blog/raw-websocket-voice-agent-voice-agent-api
