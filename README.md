# dead-domain-pinger

A GitHub composite action that probes the domains referenced by AdGuard-style filter list rules
(via [Globalping](https://globalping.io)) and removes the ones that are dead.

A domain is judged dead when DNS resolution fails, when TLS certificate validation fails, or when
it redirects to a different registrable domain. Redirects that stay inside the same registrable
domain are only detected and reported; those domains are kept. Ambiguous probe results never
delete a rule.

## Usage

```yaml
- uses: FilteringDev/dead-domain-pinger@v1
  with:
    filter-root: filterslists
    max-candidates: '50'
    state-directory: dead-domain-state
    dry-run: 'false'
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `filter-root` | `.` | Directory (relative to the workspace) to scan for filter list files |
| `file-extension` | `.txt` | File extension used by filter list files |
| `max-candidates` | `50` | Maximum number of domains to probe in a single run |
| `state-directory` | `dead-domain-state` | Directory used to persist state, report and PR body files |
| `dry-run` | `false` | Probe domains but do not write any file changes |

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
runs probe the least recently checked domains first (using `git blame` to date each rule). Upload
and restore this directory as a workflow artifact between runs to keep the queue rotating.
