# Examples

Runnable agents that show how Dome governs real workloads.

| Example | Mode | Identity | What it does |
|---|---|---|---|
| [Chess Coach](./demo-chess) | [Interactive](https://docs.domesystems.ai/tutorials/examples/interactive-agent) | Delegated coach + standing opponent | A playable chess app with two governed agents. The coach acts for the signed-in player; the opponent acts as itself. Both discover Stockfish through the Gateway, and model pools change independently of app code. |
| [GitHub activity report](./github-activity-report) | [Noninteractive](https://docs.domesystems.ai/tutorials/examples/noninteractive-agent) | Standing | On a schedule or an ad-hoc run, reads one developer's recent GitHub activity through governed MCP tools, has a model write a short report, and posts it (or prints it). Python, TypeScript, and Go are interchangeable runtimes for the same Blueprint. Nobody is chatting with the agent. |

Chess Coach is the **interactive** example: each coach request belongs to a
signed-in person. The GitHub activity report is the **noninteractive** example:
a job that runs because cron, CI, or a human invoked it, not because a user
asked a question in a session.

Each example is self-contained. Clone once and change into the one you want:

```bash
git clone https://github.com/dome-systems/examples.git
cd examples/demo-chess              # or: cd examples/github-activity-report
```

Every example reads its Dome key, provider keys, and any signing secret from
the environment. Nothing here holds a credential, and `.env` files are ignored
at the root of this repository as well as inside each example.
