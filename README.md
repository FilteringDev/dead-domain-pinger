# dead-domain-pinger

A GitHub composite action that probes the domains referenced by AdGuard-style filter list rules
(via [Globalping](https://globalping.io)) and removes the ones that are dead.

A domain is judged dead when DNS resolution fails, when TLS certificate validation fails, or when
it redirects to a different registrable domain. Redirects that stay inside the same registrable
domain are only detected and reported; those domains are kept. Ambiguous probe results never
delete a rule.

## Usage

```yaml
- uses: actions/checkout@v4
  with:
    # The queue is ordered by git history, which a shallow clone does not have.
    fetch-depth: 0

- uses: FilteringDev/dead-domain-pinger@v1
  with:
    filter-root: filterslists
    max-candidates: '50'
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

  - uses: FilteringDev/dead-domain-pinger@v1
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

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `filter-root` | `.` | Directory (relative to the workspace) to scan for filter list files |
| `file-extension` | `.txt` | File extension used by filter list files |
| `max-candidates` | `50` | Maximum probe jobs to run in a single workflow run, including queued HTTP follow-ups |
| `state-directory` | `dead-domain-state` | Directory used to write the Markdown report and PR body files |
| `state-artifact-name` | `dead-domain-pinger-state` | GitHub Actions artifact name used to carry the SQLite state database between runs |
| `worker-count` | `os.cpus().length` | Number of Node.js worker threads used to probe selected domains; when provided, it must be a positive integer |
| `dry-run` | `false` | Probe domains but do not write any file changes |
| `globalping-api-token` | - | Required Globalping access token |
| `create-pr` | `false` | Create a pull request for changed filter files using GitHub CLI |
| `report-artifact-name` | `dead-domain-pinger-report` | Artifact name for the generated Markdown report |
| `cleanup-branch-prefix` | `dead-domain-pinger/cleanup-` | Prefix for per-run branches and older pull requests to close |
| `cleanup-pr-label` | - | Optional label required when selecting older pull requests |
| `pr-base` | repository default branch | Base branch for the generated pull request |
| `pr-title` | `Remove dead domains` | Title for the generated pull request |

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

HTTPS TLS failures are queued for an HTTP retry before ordinary candidates in the next workflow
run. For a registrable-domain root with DNS or TLS failure, its HTTP retry is attempted first;
if that also has DNS or TLS failure, `www.<domain>` is queued over HTTP for the following run.
Each queued probe counts toward `max-candidates`, and a dead queued result removes the source
filter-domain rule.

## Outputs

| Name | Description |
| --- | --- |
| `has_changes` | Whether any filter list file was changed (always `false` in dry-run mode) |
| `dead_domains` | JSON array of domains judged dead in this run |
| `changed_files` | JSON array of filter list files that were changed |
| `probed_count` | Number of domains actually probed in this run |
| `rate_limited` | Whether probing stopped early because of a Globalping rate limit |
| `warning_count` | Number of warnings collected while evaluating probe results |
| `report_path` | Workspace-relative path to the generated Markdown report |
| `pr_body_path` | Workspace-relative path to the generated pull request body |

When `create-pr` is enabled, only the changed filter files are committed. The generated
`pull-request-body.md` is passed to `gh pr create --body-file`, while `dead-domain-report.md` is
uploaded separately as the `report-artifact-name` artifact. Neither generated file is committed.

## State

The action persists per-domain last-checked timestamps in a SQLite database carried by a GitHub
Actions artifact. During a run, that database is restored to a temporary directory under
`runner.temp`, updated by the action, and uploaded again as `state-artifact-name` with maximum
artifact compression. The generated Markdown report and pull request body still go under
`state-directory` in the workspace.

SQLite loading, verdict recording and saving stay in the main process. Probe workers do not touch
the database file; they send serializable probe results back to the main process, which updates the
state.

Each domain is dated individually from the git history: adding a domain to an existing rule
refreshes only that domain, and moving or reformatting a rule keeps the dates of the domains it
already carried. This needs the full history, so check the repository out with `fetch-depth: 0`.
The first run starts with an empty SQLite state when no artifact exists yet.

Selected domains are probed by a bounded Node.js worker-thread pool. By default the pool size is
`os.cpus().length`. Lower `worker-count` if the Globalping quota is tight or if parallel requests
trigger rate limiting too quickly.
