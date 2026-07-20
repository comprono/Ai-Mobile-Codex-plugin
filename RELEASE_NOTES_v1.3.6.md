# AI Mobile 1.3.6 - truthful timeout recovery

AI Mobile 1.3.6 fixes a production failure where a bounded planning worker exceeded its deadline, partial commentary was mislabeled as a generic provider failure, all routes cooled down, and an unchanged periodic reporter continued consuming tokens.

- Typed provider timeouts across every headless worker adapter.
- Complexity-aware finite planning deadlines.
- One changed recovery route instead of blind retries.
- Automatic periodic-reporter shutdown after terminal execution state.
- Regression coverage for timeout classification and reporter lifecycle.
