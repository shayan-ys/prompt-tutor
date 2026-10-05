# One JSON file per Prompt instead of SQLite

Each Prompt and its Review are stored as one JSON file, written to a temporary file and renamed into place. SQLite was rejected: even in WAL mode it allows only one writer, and `bun:sqlite` calls are synchronous inside the omp process, so a locked database would freeze the omp interface. Atomic rename gives crash-safe writes with no lock contention between concurrent omp sessions, the Watcher, and the Digest.

## Consequences

- Aggregation (Digest) reads a directory of files instead of running queries; acceptable at one person's prompt volume.
- Retention and pruning operate on files; the policy is not yet decided.
