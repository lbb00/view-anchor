---
'view-anchor': minor
---

Add `remeasure()` to the `createViewAnchor` handle and the `useViewAnchor` ref. It measures once and publishes under the current options, for moves that keep the target's size (for example after a layout commit). Unlike `update()`, it takes no options, so nothing resets to defaults; it follows `dedupe` and `treatZeroAreaAsHidden` and does not open frame following.
