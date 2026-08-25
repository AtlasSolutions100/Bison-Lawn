---
name: Local draft recovery for hydrating forms
description: How to persist and restore an in-progress form locally without the form's own hydrate/prefill effects erasing the recovered work.
---

## Rule
When a form that hydrates itself from server data (saved record, per-client prefill) also autosaves locally for
crash recovery, three things must hold or the recovery is worse than useless:

1. **Restore by remount, not by patching state.** Mount the form with the recovered values as its *initial*
   state (a changing `key` forces this). Applying them afterwards races the hydrate effects.
2. **Every hydrate/prefill effect needs a one-shot skip.** Consume the skip only once the data that would
   clobber the values has actually loaded — a guard consumed on the first (early-returning) run lets the next
   run, triggered by a `dataLoaded` dependency flipping, overwrite the restored values anyway.
3. **Gate persistence until the restore prompt is answered.** A freshly mounted, not-yet-dirty form otherwise
   immediately clears the stored copy it was supposed to offer back.

Keep the dirty baseline pointing at the *saved* state even after a restore, so recovered work still reads as
unsaved changes.

**Why:** The recovered work is the only copy left after a crash; each of the three failures deletes it
silently, and the last one deletes it before the admin ever sees the offer.

**How to apply:** Validate what the draft refers to before offering it — a deleted/no-longer-editable parent
record, or a mismatched owner (client) id, must drop the draft rather than graft values onto the wrong
record. Clear the stored copy on save, on explicit discard, and when the parent record is deleted. Treat
everything read back from storage as untrusted and drop a draft that does not parse exactly.
