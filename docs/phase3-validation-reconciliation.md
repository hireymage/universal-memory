# Phase-3 validation: migration history vs. later audited mutations

## Problem

`validateStage()` compared the migration ledger directly against the current vault:

```
expected = applied ledger entries for the stage
found    = relation id still present on the holder entity
missing  = everything else
```

That treats the ledger as a snapshot of the vault. It is not. It is **migration history**.

After Phase 3A migrated 27 relations, seven of them were legitimately removed by audited `delete_relation` operations (duplicate edges on archived merge stubs). The validator reported them as `missing`, which reads like migration failure but is not.

## Model

```
MIGRATED  →  PRESENT                        → found
MIGRATED  →  REMOVED BY VERIFIED DELETE     → intentionally_deleted
MIGRATED  →  ABSENT, NO VERIFIED DELETE     → missing
```

The ledger is never modified. The audit log is never modified. The validator only reconciles the two histories.

## Matching rule

The join key is **`(entity_id, relation_id)`**.

`target_id` is deliberately **not** used: `merge_entities` remaps relation targets from an archived stub to the canonical entity while preserving the relation id. Matching on target would break exactly the cases this rule is meant to recognise.

A relation is classified `intentionally_deleted` only when **all** of the following hold:

1. the ledger entry is `stage: relations`, `status: applied`, and has `details.relation_id`
2. the relation id is not present on the holder entity in the vault
3. an audit event exists with `operation: delete_relation`, `entity_id` equal to the holder, and `details.relation_id` equal to the relation id
4. that event's `before_snapshot` contains a relation with exactly that id
5. that event's `after_snapshot` does not contain it
6. `event.timestamp > ledger_entry.timestamp`

Anything that fails any condition stays in `missing`. The validator never guesses.

## Output shape

```json
"migrated_relations": {
  "expected": 27,
  "found": 20,
  "intentionally_deleted": [
    {
      "entity_id": "01KZRTF9QT6G955FNJKMSJHG6A",
      "relation_id": "p3r-2d25ee39aceed76ac84b",
      "audit_event_id": "01M4BYDFX94M0VVMBJQ32R1MFW",
      "deleted_at": "2026-10-07T19:46:00.745Z",
      "deleted_by": "curator-agent"
    }
  ],
  "missing": []
}
```

`expected`, `found`, `missing` and `markers_missing` keep their original meaning.

## Why not change the ledger

Appending a status such as `invalidated` to the same fingerprint would make `MigrationLedger.statusOf()` return something other than `applied`. `planRelations` skips only fingerprints whose newest status is `applied`, so the operation would become re-plannable and the relation would be **re-created**. That is the opposite of the intent.

## Regression coverage

`tests/phase3.test.ts`, describe block `validateStage: migration history vs. later audited mutations (§24F)`:

1. audited `deleteRelation` → `intentionally_deleted`, with the real audit event id
2. relation stripped directly via storage (no audit trail) → `missing`
3. audited deletion of one relation does not excuse an un-audited removal of another
4. a delete event whose before snapshot does not contain the relation → rejected
5. a delete event timestamped before the migration entry → rejected
6. relation deleted then re-added with the same id → `found`, not `intentionally_deleted`
