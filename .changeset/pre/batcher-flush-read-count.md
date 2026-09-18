---
'view-anchor': patch
---

Test-only change: the batcher's flush-cost test now counts the reads it makes against the anchor map instead of comparing two wall-clock spans, so a shared CI runner no longer fails it on timing noise. Runtime behavior is unchanged.
