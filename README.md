# dead-domain-pinger

A GitHub composite action that prefilters domains referenced by AdGuard-style filter list rules
with [AdGuard URL Filter](https://urlfilter.adtidy.org/), probes the remaining candidates via
[Globalping](https://globalping.io), and removes the ones that are dead.

Before creating Globalping measurements, the action sends Git-history-ordered candidates to the
unauthenticated URL Filter `v2/checkDomains` API in large batches. Only domains whose registered
domain was not used in AdGuard DNS during the last 24 hours are sent to Globalping. URL Filter is
only a high-volume candidate selector: Globalping remains the sole authority for deletion. A failed
URL Filter batch falls back to Globalping, so its availability cannot block a cleanup run.

By default, a domain is judged dead when DNS resolution fails, when TLS certificate validation fails, or when
it redirects to a known parking service or a different registrable domain. Known parking targets
include `forsale.godaddy.com` and take precedence even inside the same registrable domain. Other
same-domain redirects are only detected and reported; those domains are kept. Ambiguous probe
results never delete a rule.

Only plain hostnames with a registrable ICANN suffix are eligible for probing. The action collects
them from cosmetic-rule domain prefixes, `$domain` and `$from` modifiers, and network patterns
that begin with the AdGuard domain anchor (`||`). For example, `||example.com/path` contributes
`example.com`; a trailing DNS dot is normalized away. If that pattern hostname is judged dead,
the complete network rule is removed.

Unknown or reserved suffixes such as `||stats.tira.` and `example.test`, wildcard and IP hosts,
bare public suffixes, full-URL patterns, regular expressions, and unanchored network patterns are
left unchanged and do not enter the probe queue.

## Usage

```yaml
- uses: actions/checkout@v7
  with:
    # The queue is ordered by git history, which a shallow clone does not have.
    fetch-depth: 0

- uses: FilteringDev/dead-domain-pinger@v1
  with:
    filter-root: filterslists
    scan-directories: |
      filterslists/ads
      filterslists/privacy
    max-candidates: '50'
    urlfilter-prefetch-multiplier: '100'
    state-directory: dead-domain-state
    state-artifact-name: dead-domain-pinger-state
    dry-run: 'false'
    globalping-api-token: ${{ secrets.GLOBALPING_API_TOKEN }}
```

To let the action open cleanup pull requests, the calling job must grant `contents: write` and
`pull-requests: write`, and set `create-pr: 'true'`:

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0

  - uses: FilteringDev/dead-domain-pinger@VERSION
    with:
      create-pr: 'true'
      globalping-api-token: ${{ secrets.GLOBALPING_API_TOKEN }}
```

Each changed run creates a branch named `dead-domain-pinger/cleanup-<run id>`. Older open pull
requests whose branches use the configured prefix are closed before the new pull request is
created. Set `cleanup-pr-label` to require a label when selecting older pull requests. Runs with
no changes and dry runs do not commit, push, close, or create pull requests. Automatic pull
requests require a trusted scheduled or manual workflow; fork pull requests generally cannot
provide the required secret or write permissions.

## Matrix workflow

For large repositories, use the staged v2 actions so Git history indexing and the AdGuard URL
Filter prefilter run once per directory scope. `postprocess` then merges all worker outputs,
deduplicates domains, restores global oldest-first order, applies `max-candidates` once, and is
the only job that calls Globalping or writes SQLite state.

```yaml
name: Dead domain cleanup

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  matrix-build:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.matrix.outputs.matrix }}
      worker_count: ${{ steps.matrix.outputs.worker_count }}
    steps:
      - uses: actions/checkout@v7
      - id: matrix
        uses: FilteringDev/dead-domain-pinger/matrix-build@VERSION
        with:
          scan-directories: |
            SpywareFilter
            BaseFilter
            SocialFilter

  worker:
    needs: matrix-build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.matrix-build.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: FilteringDev/dead-domain-pinger/worker@VERSION
        with:
          filter-root: .
          scan-directory: ${{ matrix.Directory }}
          scope-id: ${{ matrix.Id }}
          worker-artifact-prefix: dead-domain-worker

  postprocess:
    needs: [matrix-build, worker]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: FilteringDev/dead-domain-pinger/postprocess@VERSION
        with:
          filter-root: .
          max-candidates: '50'
          globalping-api-token: ${{ secrets.GLOBALPING_API_TOKEN }}
          expected-worker-count: ${{ needs.matrix-build.outputs.worker_count }}
          worker-artifact-prefix: dead-domain-worker
          state-artifact-name: dead-domain-pinger-state
          report-artifact-name: dead-domain-pinger-report
```

`matrix-build` receives the newline-delimited directory scopes. It removes nested scopes, so a
file cannot be handled by two workers. When the input is empty it emits one `.` scope. Each
`worker` uploads exactly one versioned JSON artifact named
`<worker-artifact-prefix>-<scope-id>`; it contains only Git-history and URL Filter candidate
data, never credentials or Globalping verdicts.

`postprocess` must run after every worker and use the matching artifact prefix plus
`expected-worker-count`. It fails when a result is missing or duplicated rather than rewriting
filters from partial data. It inventories the full `filter-root` before saving state, preserving
SQLite entries for domains outside the matrix scopes. The SQLite artifact is created and uploaded
only by `postprocess` for that workflow run. Artifacts are scoped to a workflow run; use a
separate durable store if state must be restored by a later workflow run.

Use `dry-run: 'true'` on `postprocess` to produce only the report and diff artifact. Workers do
not require `GLOBALPING_API_TOKEN`; provide that secret only to `postprocess`.

## Local preview and debugging

Run the same probe and rewrite pipeline against a local checkout without changing its files,
Git metadata, or SQLite state:

```sh
pnpm install --no-lockfile
GLOBALPING_API_TOKEN=... pnpm run local -- \
  --workspace /path/to/filter-repository \
  --output /path/outside/filter-repository/dead-domain-preview \
  --state-path /path/to/dead-domain-state.sqlite
```

The output directory must be outside the target checkout. A successful run writes exactly
`dead-domain.diff` and `dead-domain-report.md`. The diff uses the checkout's current on-disk
contents as its baseline, so unrelated local edits are not included as separate changes. Review
and apply it from the target checkout with:

```sh
git apply --check /path/to/dead-domain-preview/dead-domain.diff
git apply /path/to/dead-domain-preview/dead-domain.diff
```

An empty diff means no filter changes were proposed. The local runner requires a read-only
SQLite snapshot through `--state-path`, so domain ages and queued HTTP follow-ups use the same
persisted state as the workflow. It also accepts `--filter-root`, `--scan-directories`,
`--file-extension`, `--max-candidates`, `--urlfilter-prefetch-multiplier`, `--worker-count`, and
`--ordering-worker-count`; run it with `--help` for the complete interface.

In GitHub Actions, setting `dry-run: 'true'` provides the same non-mutating preview. The report
artifact contains both files, persisted state is not updated or uploaded, and `has_changes`
reports whether the preview diff is non-empty.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `filter-root` | `.` | Directory (relative to the workspace) to scan for filter list files |
| `scan-directories` | - | Newline-delimited workspace-relative directories. Only domains currently found in these directory subtrees are eligible for probing and rewriting; empty scans every file under `filter-root`. |
| `file-extension` | `.txt` | File extension used by filter list files |
| `max-candidates` | `50` | Maximum probe jobs to run in a single workflow run, including queued HTTP follow-ups |
| `urlfilter-prefetch-multiplier` | `100` | Number of pending-first, Git-history-ordered candidates URL Filter considers per intended Globalping job. If fewer unused candidates are found, later candidates are considered until the Globalping job limit is reached. |
| `state-directory` | `dead-domain-state` | Directory used to write state, report, and PR body files outside dry-run mode |
| `state-artifact-name` | `dead-domain-pinger-state` | GitHub Actions artifact name used to carry the SQLite state database between runs |
| `worker-count` | `os.cpus().length` | Number of Node.js worker threads used for selected-domain probes; when provided, it must be a positive integer |
| `ordering-worker-count` | `os.availableParallelism()` | Maximum number of concurrent per-line Git history workers; when provided, it must be a positive integer |
| `dry-run` | `false` | Emit a Git diff and Markdown report without modifying the checkout, Git metadata, or persisted state |
| `globalping-api-token` | - | Required Globalping access token |
| `create-pr` | `false` | Create a pull request for changed filter files using GitHub CLI |
| `report-artifact-name` | `dead-domain-pinger-report` | Artifact name for the report and, in dry-run mode, the generated Git diff |
| `cleanup-branch-prefix` | `dead-domain-pinger/cleanup-` | Prefix for per-run branches and older pull requests to close |
| `cleanup-pr-label` | - | Optional label required when selecting older pull requests |
| `pr-base` | repository default branch | Base branch for the generated pull request |
| `pr-title` | `Remove dead domains` | Title for the generated pull request |

`scan-directories` narrows current candidate selection and filter rewrites after filter files are
discovered under `filter-root`. State pruning still considers domains found in all discovered filter
files, so a verdict, pending retry, or Git-order cache entry remains available while that domain
also appears outside the configured directories.

## Globalping configuration

An optional `dead-domain-pinger-config.json` at the repository root configures the Globalping
measurement fields. Its `locations` and `limit` fields use the Globalping API request format:

```json
{
  "locations": [{ "country": "KR", "tags": ["eyeball-network"] }],
  "limit": 5
}
```

When the file is absent, or either field is omitted, the action uses `limit: 5` and one
`eyeball-network` probe each from the US, Europe, Korea, Japan, and India. An invalid config
file fails the workflow instead of silently changing the requested measurement.

### Judgement preferences

The same config file can replace the automated judgement policy. Policies are evaluated separately
for the two AGTree origin types:

- `networkPattern`: a hostname from an anchored network pattern such as `||example.com^`.
- `domainList`: a non-negated hostname from a cosmetic prefix or a `$domain`/`$from` modifier.

Policy layers are applied in this order: built-in policy, `default`, then the matching origin policy.
Each configured `dns`, `http`, or `body` array replaces that whole stage from the preceding layer;
an empty array disables the stage. Omitted stages continue to inherit. Rule IDs must be unique across
an effective policy. Rules run in array order, and the first matching `alive`, `dead`, or `unknown`
verdict is terminal. A matching `continue` rule skips the rest of its stage and advances to the next
stage. Falling through every stage produces `Unknown`,
which never removes an occurrence.

This example treats a 404 majority as dead only for network-pattern occurrences while leaving the
built-in policy unchanged for domain-list occurrences:

```json
{
  "judgementPreferences": {
    "networkPattern": {
      "http": [
        {
          "id": "network-pattern-404-majority",
          "when": {
            "signal": "statusCode",
            "values": [404],
            "minimumMatches": 3,
            "minimumRatio": 0.6
          },
          "verdict": "dead"
        }
      ]
    }
  }
}
```

Both `minimumMatches` (default `1`) and optional `minimumRatio` must pass. The ratio denominator is
every result returned by Globalping, including results that do not contain the selected signal.
Conditions can be composed recursively with `{ "all": [...] }`, `{ "any": [...] }`, and
`{ "not": ... }`.

Available signals are stage-specific:

| Stage | Signals | Extra fields |
| --- | --- | --- |
| `dns` | `dnsResolved`, `dnsFailure` | - |
| `http` | `tlsValidationFailure`, `timeout`, `redirect`, `parkingRedirect`, `foreignRedirect`, `sameDomainRedirect`, `statusCode`, `probeFailure` | `statusCode` requires `values`, containing exact codes or `1xx` through `5xx` |
| `body` | `bodyPresent`, `bodyTruncated`, `parkingProvider`, `bodyMatcher` | `parkingProvider` accepts `providers`; `bodyMatcher` requires `matcher` |

DNS signals use resolution evidence already returned by the Globalping HTTP measurement; they do
not create a separate DNS measurement. Body inspection is limited to the first 10 KiB and is
disabled by the built-in policy. Built-in parking body providers are `godaddy`, `sedo`, `bodis`,
`hugeDomains`, and `namecheap`. Response bodies are never copied into results or reports.

Custom body matchers are native literal or regular-expression matchers. Regular-expression flags
are limited to `i`, `m`, `s`, and `u`:

```json
{
  "judgementPreferences": {
    "matchers": {
      "expired-page": {
        "type": "regex",
        "pattern": "domain\\s+(?:expired|for sale)",
        "flags": "iu"
      }
    },
    "default": {
      "http": [
        {
          "id": "inspect-success-body",
          "when": { "signal": "statusCode", "values": ["2xx"] },
          "verdict": "continue"
        }
      ],
      "body": [
        {
          "id": "expired-body",
          "when": {
            "any": [
              { "signal": "parkingProvider" },
              { "signal": "bodyMatcher", "matcher": "expired-page" }
            ]
          },
          "verdict": "dead"
        }
      ]
    }
  }
}
```

Because a configured stage is a replacement, the abbreviated HTTP stage above intentionally omits
the built-in TLS, redirect, and timeout rules. Production policies should restate any inherited
rules they still need. Configuration is bounded to 100 rules per stage, 100 body matchers,
1,024 characters per matcher pattern, 12 expression levels, and 256 expression nodes.

The built-in policy is equivalent to these ordered decisions:

1. All probes report DNS failure: `Dead`.
2. All probes report TLS validation failure: `Dead`.
3. All probes redirect and at least one redirects to a known parking host: `Dead`.
4. All probes redirect and at least one redirects to a foreign registrable domain: `Dead`.
5. At least one probe returns HTTP 2xx: `Alive`.
6. At least one probe times out: `Alive`.
7. Otherwise: `Unknown`.

When the effective policy changes, its fingerprint changes and persisted verdict ages and queued
follow-ups are invalidated so every candidate is reconsidered under the new preferences.

HTTPS TLS failures are queued for an HTTP retry before ordinary candidates in the next workflow
run. For a registrable-domain root with DNS or TLS failure, its HTTP retry is attempted first;
if that also has DNS or TLS failure, `www.<domain>` is queued over HTTP for the following run.
Each queued probe counts toward `max-candidates`. A dead judgement remains provisional while a
follow-up is queued, so deletion is postponed; only a terminal dead follow-up removes occurrences
for the origin types that its policy judged dead.

## Outputs

| Name | Description |
| --- | --- |
| `has_changes` | Whether any filter list change was applied or proposed by a dry run |
| `dead_domains` | JSON array of domains judged dead in this run |
| `dead_domain_origins` | JSON object mapping each dead domain to the origin types judged dead (`networkPattern` and/or `domainList`) |
| `changed_files` | JSON array of filter list files that were changed |
| `probed_count` | Number of domains actually probed in this run |
| `rate_limited` | Whether probing stopped early because of a Globalping rate limit |
| `warning_count` | Number of warnings collected while evaluating probe results |
| `report_path` | Workspace-relative path to the generated Markdown report; a dry-run path may lead outside the checkout |
| `diff_path` | Workspace-relative path to `dead-domain.diff` in dry-run mode; empty otherwise |
| `pr_body_path` | Workspace-relative path to the generated pull request body; empty in dry-run mode |

When `create-pr` is enabled, only the changed filter files are committed. The generated
`pull-request-body.md` is passed to `gh pr create --body-file`, while `dead-domain-report.md` is
uploaded separately as the `report-artifact-name` artifact. Neither generated file is committed.
Dry runs do not create the pull request body; their report artifact contains
`dead-domain-report.md` and `dead-domain.diff` instead.

## State

The action persists per-domain last-checked timestamps in a SQLite database carried by a GitHub
Actions artifact. During a run, that database is restored to a temporary directory under
`runner.temp`, updated by the action, and uploaded again as `state-artifact-name` with maximum
artifact compression. The generated Markdown report and pull request body still go under
`state-directory` in the workspace for ordinary runs. Dry runs read the restored database as a
snapshot, discard all in-memory updates, and write their report and diff under `runner.temp`.

SQLite loading, verdict recording and saving stay in the main process. Probe workers do not touch
the database file; they send serializable probe results back to the main process, which updates the
state.

The state database also caches Git-derived domain modification times. The main process supplies
valid cache entries to ordering workers, which skip deep-history lookups for cache hits and return
new entries for cache misses. A cache entry is valid while its filter file has the same most recent
Git commit; unrelated commits retain it, while a filter-file change or local uncommitted edit causes
that file to be indexed again. The first run has no Git ordering cache, and dry runs continue to
read the cache without updating it.

Each domain is dated individually from the git history: adding a domain to an existing rule
refreshes only that domain, and moving or reformatting a rule keeps the dates of the domains it
already carried. This needs the full history, so check the repository out with `fetch-depth: 0`.
The first run starts with an empty SQLite state when no artifact exists yet.

Git history is searched as a stream with at most `ordering-worker-count` rule lines in flight.
Independent lines from the same filter file can run concurrently, so the default uses
`os.availableParallelism()` to make all CPUs available for ordering. Domains from the same line
stay together to avoid repeating identical history work. Existing `worker-count` settings apply
only to probing; lower `ordering-worker-count` on memory-constrained runners.

Selected domains are probed by a separate bounded Node.js worker-thread pool. By default the pool
size is `os.cpus().length`. Lower `worker-count` if the Globalping quota is tight or if parallel
requests trigger rate limiting too quickly.
