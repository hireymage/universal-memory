# Resolve-archived fixture vault

Read-only fixture mirroring the real production situation after `merge_entities`
archives a duplicate stub: one canonical active person plus one archived stub
with the identical title (and, for Jan/Eva, the identical alias).

Used by `tests/resolve-archived.test.ts`. Nothing in the tests writes here
(`read_only: true`), so the fixture is never mutated.
