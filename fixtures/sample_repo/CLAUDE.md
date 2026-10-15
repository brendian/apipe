# mathutils

Tiny JavaScript project used as the target of advpipe's tests and dry runs.

## Commands

```sh
node --test          # run the tests
```

## Conventions

- ES modules, no dependencies, no build step.
- Public API is re-exported from `mathutils/index.js`.
- Every function has a doc comment and a test in `tests/`.
- Don't modify tests to make them pass.
