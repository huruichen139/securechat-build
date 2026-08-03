# SecureChat Feature Matrix

`FEATURE_MATRIX.json` is the generated, auditable backlog for the 10,000+ feature target.

## Regenerate

```powershell
node generate-feature-matrix.js
```

Each row is an atomic combination of:

- 20 product modules
- 25 capabilities per module
- 5 actors
- 4 surfaces
- 5 lifecycle states
- 3 network conditions
- 4 acceptance dimensions

Invalid actor/surface/state combinations are filtered out. The generated count must remain above 10,000. Rows have stable IDs, module, capability, actor, surface, lifecycle, network, acceptance dimension, priority, and status fields.

## Delivery rule

The matrix is a backlog, not a claim that every item is already implemented. Each feature must move through `planned`, `in-progress`, `testing`, and `done`, with an implementation and repeatable acceptance test before being marked complete.

The first implementation batches prioritize authentication and data safety, reliable messaging, group permissions, notifications, search, privacy, files, calls, and AI key isolation. The design borrows general interaction patterns from modern communication products while using original SecureChat code, assets, and protocol definitions.
