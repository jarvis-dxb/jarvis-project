// Keep previously validated, subsequently deleted filters restrictive. Silently
// pruning the final missing ID to [] would subscribe the user to every setup.
// New selections must still be owned, and an ID now owned by someone else must
// never be grandfathered in merely because an old preference contains it.
export async function validateSetupSelections(values, { ownedIds, previousIds, exists }) {
  const fail = () => { throw Error('Choose your own setups.'); };
  if (!Array.isArray(values) || values.length > 200 || values.some(id => typeof id !== 'string')) fail();
  const selected = [...new Set(values)], owned = new Set(ownedIds);
  const previous = new Set(Array.isArray(previousIds) ? previousIds : []);
  for (const id of selected) {
    if (owned.has(id)) continue;
    if (!previous.has(id)) fail();
    if (await exists(id)) {
      throw Error('A selected setup is no longer available. Uncheck unavailable setup filters, then save again.');
    }
  }
  return selected;
}
