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
    dry-run: 'false'
    # Optional: raises the anonymous rate limit and allows max-candidates above 50.
    globalping-api-token: ${{ secrets.GLOBALPING_API_TOKEN }}
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `filter-root` | `.` | Directory (relative to the workspace) to scan for filter list files |
| `file-extension` | `.txt` | File extension used by filter list files |
| `max-candidates` | `50` | Maximum number of domains to probe in a single run (may only exceed 50 when `globalping-api-token` is set) |
| `state-directory` | `dead-domain-state` | Directory used to persist state, report and PR body files |
| `dry-run` | `false` | Probe domains but do not write any file changes |
| `globalping-api-token` | `''` | Globalping API token (optional; raises the anonymous rate limit and unlocks `max-candidates` above 50) |

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

## State

The action persists per-domain last-checked timestamps under `state-directory` so that repeated
runs probe the least recently checked domains first. Each domain is dated individually from the
git history: adding a domain to an existing rule refreshes only that domain, and moving or
reformatting a rule keeps the dates of the domains it already carried. This needs the full
history, so check the repository out with `fetch-depth: 0`. Upload and restore the state directory
as a workflow artifact between runs to keep the queue rotating.
