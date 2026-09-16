---
'view-anchor': patch
---

Add an optional `signal` (`AbortSignal`) to the creators that own DOM observers or scheduled work. An already-aborted signal starts no work, and aborting later is equivalent to calling `dispose()`. README, docs, and package metadata now describe measuring DOM bounds without assuming Electron or a particular transport.
