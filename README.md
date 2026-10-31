# CodeRev

Self-hosted pull request review. Runs a cheap model over the diff, then puts
every finding to a panel of independent skeptics and posts only what survives.

Zero runtime dependencies. Node 24, an API key, and either the `gh` CLI (GitHub)
or a token for your Gitea or Forgejo server.

## Status

A personal tool, published because it works and might be useful to someone
else. It runs on my own repos, gets fixes when something breaks there, and
issues and PRs are welcome, but there is no support promise. Pin a release tag
or a commit SHA rather than `main`, so an update never reaches your CI before
you choose it.

## Why the panel

Cheap models generate plausible-and-wrong findings freely. A reviewer that
reports five issues per PR and is wrong on four is worse than no reviewer,
because it trains everyone to skim past the check.

So generation and judgement are separated. Generation is tuned for recall: it
asks for every plausible defect with a named mechanism, because a generator
that stays quiet cannot be rescued by anything downstream. Each finding then
goes to a panel of three skeptics, each with an assigned lens — checkability,
mechanism accuracy against the code, scope-and-intent — so every ground for
refutation is somebody's whole job rather than something three identical
voters might each happen to skip. A finding survives only if fewer than half
the panel refutes it, and a refutation must name its specific reason:
uncertainty alone does not count, but neither does a claim survive that is too
vague to check. Unparseable votes and failed requests count as refutations.

This is deliberately token-hungry, roughly `1 + 3N` calls per PR. That is the
point rather than a cost to be minimised: tokens are cheap, and the panel is
what buys precision. It also happens to be close to a best case for prompt
caching, since every vote re-sends the same diff.

## Usage as an action

```yaml
name: PR review
on:
  pull_request:
    types: [opened, ready_for_review, labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    continue-on-error: true
    # Forks do not get secrets, so the model call would fail with a confusing
    # auth error rather than an obvious skip.
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v6
      - uses: btsouth/coderev@v1
        with:
          api-key: ${{ secrets.REVIEW_API_KEY }}
          conventions: AGENTS.md
```

`@v1` follows the latest 1.x release. For a fixed version pin `@v1.0.0` or a
full commit SHA.

Start it advisory (`continue-on-error: true`). A red X on a model's opinion
trains people to ignore the whole check. Promote it to required only once its
precision has earned that.

### Gitea and Forgejo

The same workflow works on Gitea and Forgejo Actions, saved under
`.gitea/workflows/` or `.forgejo/workflows/`. CodeRev sees the runner's
`GITEA_ACTIONS` or `FORGEJO_ACTIONS` variable and talks to the server's REST
API directly, so the runner image needs no `gh`. The job's automatic token is
enough to read the PR and post the comment.

If the instance's default actions URL is not GitHub, use the full form:
`uses: https://github.com/btsouth/coderev@v1`.

To run it against a Gitea PR from your own machine:

```bash
export CODEREV_FORGE=gitea CODEREV_GITEA_URL=https://git.example.com GITEA_TOKEN=...
node bin/review-pr.ts --pr 12 --repo ../some-repo
```

The repository comes from `CODEREV_REPOSITORY=owner/repo`, or else the
checkout's `origin` remote. `CODEREV_FORGE=github` forces the GitHub path.

## Usage locally

```bash
export REVIEW_API_KEY=sk-...
node bin/review-pr.ts --pr 123 --repo ../some-repo
```

Add `--post` to comment on the PR instead of printing, and `--context` to
fetch the full contents of changed files into the find stage (experimental:
in benchmarks it produced better-grounded findings but did not improve recall
of cross-file defects, and it suppressed candidate volume on very large PRs).
`--help` on either binary lists every flag.

## Providers

Any OpenAI-compatible `/chat/completions` endpoint. Switching is environment
variables, never a code change.

| Variable | Purpose |
| --- | --- |
| `REVIEW_API_KEY` | Model key. Falls back to the provider's own variable (`DEEPSEEK_API_KEY`, etc). |
| `REVIEW_PROVIDER` | `deepseek` (default), `openrouter`, `openai`, `meta`, `exec`. |
| `REVIEW_MODEL` | Overrides the provider's default model. |
| `REVIEW_API_BASE_URL` | Any other compatible endpoint, including a local server. |
| `REVIEW_EXEC_COMMAND` | Command used by the `exec` provider. |

DeepSeek V4 Flash is currently the default during its viability trial, and it
bills per token. That last part matters more than it sounds.
Subscription-backed coding CLIs generally cannot authenticate
non-interactively, which rules them out for CI whatever their token value.

Anthropic-compatible HTTP gateways (`/v1/messages`) are not supported. That is
a second HTTP client rather than a preset.

### Subscription CLI provider

On a self-hosted runner with an already authenticated CLI, CodeRev can write
the complete system and user prompts to stdin and read stdout as the model
completion:

```yaml
- uses: btsouth/coderev@v1
  with:
    provider: exec
    exec-command: grok
```

The action's `grok` shorthand uses its bundled trusted wrapper to pass large
prompts through a temporary file. The wrapper is Windows PowerShell, so the
shorthand only works on Windows runners; elsewhere pass a full command. CLI
token usage is intentionally reported as unknown. Confirm that the
subscription terms permit automated pipeline use before enabling this. The
same transport works for stage overlays through `find2-provider: exec` /
`find2-exec-command` and `refute-provider: exec` /
`refute-exec-command`.

### Optional Linear follow-ups

Automatic filing is off by default. A repo may opt in with
`linear-follow-ups: true`, `linear-api-key`, and `linear-team-id`. CodeRev only
files fresh findings that survived the verification panel and carry both
`disposition: follow-up` and `confidence: high`; everything else remains in
the review comment.

## Benchmarking

Picking a model from pricing pages does not work, because the cost that matters
depends on your diffs, your cache hit rate, and how many candidate findings the
model generates. So measure it:

```bash
node bin/review-benchmark.ts \
  --suite fixtures/toolport-studio.json \
  --repo ../toolport-studio \
  --model deepseek-v4-pro \
  --model deepseek-v4-flash \
  --limit 3
```

This runs the identical pipeline the action ships, over recorded PRs, and
reports measured cost against agreement with whatever reviewer you are
comparing to.

**Read the output carefully.** Cost is real: it comes from reported token usage,
including the cache-hit split, not from an estimate. Agreement is not.
Agreement with a baseline is agreement with whatever that baseline happened to
say, including findings its own authors ignored, which is why `actedOn` is
tracked separately. A finding that matches nothing is reported as *unmatched*,
never as a false positive, because it may be a real defect the baseline missed.

### Suite format

See [fixtures/toolport-studio.json](fixtures/toolport-studio.json). Each case is
a PR number, the baseline findings as `file`/`line`, and whether the PR received
any commit after that review landed.

## Security

The model only ever sees text: with an HTTP provider it has no tools, so the
worst a hostile PR can do is steer the comment it gets (and, if enabled, the
Linear follow-ups it files). The exec provider is different. An agentic CLI with auto-approved tools reads the checkout, so only
point it at code you trust, on a runner you would let that code touch.

Keep the fork guard from the example: forks get no secrets, and a review of
untrusted code should not hold your API key.

Report vulnerabilities privately through GitHub's
[security advisories](https://github.com/btsouth/coderev/security/advisories/new),
not in a public issue.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests use `node:test` and cover the pure logic: parsing, the panel majority,
cost arithmetic, and baseline matching. Nothing in the test suite makes a
network call.

## License

MIT
