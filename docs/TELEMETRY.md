# Telemetry

OpenDots sends one kind of telemetry: [browser setup telemetry](SETUP-TELEMETRY.md),
which records setup steps (viewed, failed, activated, abandoned) and never
prompts, answers, keys or conversation content. It is on by default. Set
`DO_NOT_TRACK=1` or `COPILOTKIT_TELEMETRY_DISABLED=true` on the server and
restart to turn it off. `npm test` disables it for ordinary fixtures.

## What changed in phase 4

Earlier releases embedded the CopilotKit SDK, whose runtime also sent
`oss.runtime.instance_created` and `oss.runtime.copilot_request_created` events
and used a CLI-issued `CPK_TELEMETRY_ID` to attribute usage to an Intelligence
account. OpenDots no longer includes the SDK, so those runtime events are no
longer sent, and there is no Intelligence account to attribute.

Setup telemetry still goes to `https://telemetry.copilotkit.ai/ingest`, tagged
`accessibility_title: "OpenDots"`. A nonblank `CPK_TELEMETRY_ID` is still used
as its transport identity when present; otherwise a random persistent
installation UUID is used.

## Reporting queries

| Query                                                                    | Status                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| [Setup events](telemetry/opendots-setup.hogql.sql)                       | Current                                                   |
| [Installation conversion](telemetry/opendots-setup-conversion.hogql.sql) | Current                                                   |
| [Signup accounts](telemetry/opendots-signups.hogql.sql)                  | Covers releases before phase 4 only (uses runtime events) |
| [Daily usage](telemetry/opendots-usage.hogql.sql)                        | Covers releases before phase 4 only (uses runtime events) |

Activation (`oss.runtime.setup_activated`) is the closest current signal to
"this installation got a real answer". An HTTP `202` from ingest alone does not
prove PostHog delivery.
