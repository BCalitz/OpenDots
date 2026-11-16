# Build specs

One file per feature in the phase being built. The [roadmap](../ROADMAP.md) says why each feature exists and in what order; a spec says exactly what to build. The screens are drawn in the [design canvas](https://claude.ai/artifact/C8YuNty1R1zDMZhgmg95VX).

Specs are written one phase ahead, not for the whole roadmap, because a spec written long before its code goes stale.

## Phase 1: home and call

Build in this order. Each one works on its own.

| Spec                                                | Depends on | Status      |
| --------------------------------------------------- | ---------- | ----------- |
| [1.2 One assistant](1.2-one-assistant.md)           |            | Not started |
| [1.1 Home](1.1-home.md)                             | 1.2        | Step 1 done |
| [1.3 Call through today](1.3-call-through-today.md) | 1.1        | Not started |
| [1.4 Spoken decisions](1.4-spoken-decisions.md)     | 1.3        | Not started |

## Ready to build beside phase 1

These do not depend on phase 1 and can be built at the same time.

| Spec                                      | Depends on                                      | Status      |
| ----------------------------------------- | ----------------------------------------------- | ----------- |
| [2.1 Calendar](2.1-calendar.md)           | Merge after 1.2 step 3, so its tools get a risk | Not started |
| [4.1 Look back 60 days](4.1-look-back.md) |                                                 | Not started |
| [6.8 Live checks](6.8-live-checks.md)     |                                                 | Not started |
| [6.9 Costs in money](6.9-costs.md)        |                                                 | Not started |

To build these with several agents at once, split them by step as the roadmap's [Building in parallel](../ROADMAP.md#building-in-parallel) section shows. If you are given part of a spec, build only the steps you were given.

## How to use a spec

1. Read the spec and the files it names before changing anything. Where the spec and the code disagree about what exists today, the code is right: say so and adjust.
2. Build it in the steps the spec lists. Each step should leave the app working.
3. Write the tests the spec lists. Add more where you find an edge the spec missed.
4. Update the docs the spec names, set its status in the table above, and move its row in the roadmap's **Built** table when it is done.

A section marked **Decision** records a choice the owner made. Do not change it without asking. A section marked **Open** is not decided: ask before building it.
