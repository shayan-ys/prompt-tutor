# Users install from `main`, with no release ref

prompt-tutor is installed with `omp plugin install github:shayan-ys/prompt-tutor`, once per omp profile, with no Git ref. omp records that source, so `omp plugin upgrade prompt-tutor` re-resolves `main` and brings each profile up to date in one command. A pinned tag (`#vX.Y.Z`) was rejected because `omp plugin upgrade` re-resolves the recorded ref and never moves a pinned tag forward, so every upgrade would be a manual reinstall with the next tag in each profile. A `release` branch fast-forwarded to each tag was the other candidate: it keeps unreleased work off users' machines at the cost of one extra step per release. Installing from `main` was chosen over it, which moves that safety onto `main` itself. An npm package was rejected: it adds a registry account and publish step, and its main benefit (a bin on PATH) is covered by the `/prompt-tutor install-watcher` command.

## Consequences

- Every merge to `main` reaches users on their next upgrade, so `main` must always be releasable: protected, and merged only through a passing CI gate.
- Tags still mark versions; a user who wants a frozen version can install `#vX.Y.Z`, but then upgrades by reinstalling with a newer tag.
- Profiles can run different versions of prompt-tutor against the same store, so stored files carry a format version.
- Moving to a release ref later means every existing user reinstalls, because omp keeps the ref recorded at install.
