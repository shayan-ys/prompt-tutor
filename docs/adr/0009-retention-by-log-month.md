# Retention prunes whole Review log months, and only when configured

prompt-tutor keeps every Prompt and Review unless the config sets `keep_months` (an integer, at least 2). Then it keeps the current local month and the `keep_months - 1` months before it, and prunes older months. The unit is the Review log month fixed at capture (ADR 0006), because each log page and its per-Review stubs belong to exactly one month: pruning a month removes its `prompts/<month>/` directory, its `log/<month>.html` page, and the stub of each of its Reviews, in the Scope and in the all-Scopes log. The prune runs in the background of every omp session start, over every Scope in the config. It deletes local files only and sends nothing to a provider, so it needs no profile routing like the Digest's (ADR 0007). Stubs and pages go first and the Prompt files last, so an interrupted prune is finished by the next session. Digests are never pruned: they are small, and their trend lines read `digests/*.json`, not Reviews.

Pruning by default was rejected. A tutor that deletes a learner's history without being asked is a surprise that cannot be undone, and the data is small. A minimum of 2 months keeps the week that the next Digest reads, even when that week starts in the previous month.

Removing prompt-tutor does not remove its data either: omp's plugin uninstall runs no hook. `prompt-tutor --delete-data` lists every path it would delete, and `--yes` deletes them. It removes only the paths prompt-tutor writes (`prompts/`, `log/`, `digests/` with its lock, and `digest.html` in each Scope store, and the all-Scopes log), then removes directories that are left empty. It leaves unknown files and the config file in place and reports them. A store can be any directory that the config names, so deleting the whole directory was rejected.

## Consequences

- Shortening `keep_months` deletes the newly expired months at the next session start.
- `--delete-data` reads the current config. If Scopes were renamed or removed earlier, their old stores are not found, so the README lists the default data directory.
- Run `--delete-data` before removing the Watcher link, because the link is the command that runs it.
