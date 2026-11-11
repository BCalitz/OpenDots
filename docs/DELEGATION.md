# Dots that direct other Dots

You can talk to one Dot and let it hand work to your specialist Dots.

## Set it up

1. Create the specialists, each with clear role instructions, for example a Researcher and a Writer.
2. Open the Dot you want to talk to (**Edit specialist**) and, under **Other Dots it can direct**, tick the specialists.
3. Chat with that Dot as usual. When a request fits a specialist, it calls the `ask_dot` tool with a complete request, waits for the answer and uses it in its reply.

## How it behaves

- **Its own conversation.** Each specialist answers in a conversation of its own, one per coordinator conversation, titled "From <Dot>: …". Open it from the specialist's thread list to see exactly what it was asked and what it did. Later requests in the same coordinator conversation continue that thread, so the specialist keeps context.
- **One level only.** A Dot answering another Dot does not get `ask_dot`, so work cannot bounce between Dots.
- **Its own permissions.** A specialist uses only its own Spaces, research, memory, apps, computer and connections. **Ask first** connection tools cannot run in a specialist's turn, because nobody is there to approve them; the specialist says so and you can continue in its conversation.
- **Limits.** Each Dot's tokens count toward its own monthly limit. The coordinator's turn time limit (`AGENT_RUN_TIMEOUT_MS`) covers the specialists it waits for, so raise it if specialists do long research.
- **Stopping.** Stopping or pausing the coordinator stops the specialist it is waiting on. Changing who a Dot can direct stops its current turn.
- **Visible.** Specialist runs appear in **Insights > Runs** with the prompt marked "Dot request".

Requests to the same specialist from one conversation run one at a time.
