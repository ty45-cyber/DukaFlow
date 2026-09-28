# DukaFlow Architecture

```text
Customer microphone
      |
      v
AssemblyAI Voice Agent API
  STT / LLM / TTS / turns / interruption
      |
      | tool.call
      v
DukaFlow Tool Gateway
      |
      +--> Product Resolver
      +--> Inventory Rules
      +--> Evidence Gate
      +--> Transaction State Machine
      +--> Payment Provider Boundary
      |
      v
Persisted business state
      |
      v
Merchant Console + Audit Trace
```

## Non-negotiable invariants

1. No product not present in the active catalog may be ordered.
2. No order may reserve more stock than is currently available.
3. No consequential field may execute without evidence.
4. No order may be created without explicit user confirmation.
5. No duplicate idempotency key may create a second order.
6. The application cannot mark a payment paid merely because the LLM says so.
7. Sandbox payment is never represented as real payment.
8. Illegal state transitions are rejected by the domain layer.

## Risk tiers

**Low:** retrieval and calculation.

**Medium:** cart changes and reservations.

**High:** order creation, payment requests, refunds/cancellations.

As risk increases, the system requires stronger evidence and authorization.
