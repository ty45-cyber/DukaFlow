# 90-Second Judge Demo

## 0–10 seconds

Show the merchant console and say:

> “Most voice agents can talk. DukaFlow is designed not to guess its way into a transaction.”

## 10–50 seconds

Customer says:

> “I need the big SunGold. Three. Actually make it two. Deliver to CBD.”

Let the agent clarify any ambiguity.

Interrupt the agent once during a response if the UI is stable enough to demonstrate barge-in.

## 50–70 seconds

When the agent reads the final total, say:

> “Yes, place the order.”

The evidence gate should flip all five checks to green.

## 70–90 seconds

Show:

- order ID
- stock reservation
- payment pending
- sandbox label
- execution trace

Then say:

> “AssemblyAI handles the conversation. DukaFlow verifies the evidence and controls the transaction.”

## Deliberate failure demo

Before the successful order, say only:

> “Send me the blue one.”

When multiple candidates exist, DukaFlow should clarify instead of guessing. This demonstrates the safety invariant rather than merely claiming it.
