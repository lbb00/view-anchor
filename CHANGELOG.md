# view-anchor

## 0.2.2

### Patch Changes

- 69a947d: Add an optional `signal` (`AbortSignal`) to the creators that own DOM observers or scheduled work. An already-aborted signal starts no work, and aborting later is equivalent to calling `dispose()`. README, docs, and package metadata now describe measuring DOM bounds without assuming Electron or a particular transport.

## 0.2.2-alpha.0

### Patch Changes

- a64c35d: Test the Changesets and npm Trusted Publishing workflow end to end with an alpha prerelease. No functional change.
