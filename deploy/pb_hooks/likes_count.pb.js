/// <reference path="../pb_data/types.d.ts" />
// Atomic-ish counter maintenance: every favorite create bumps spots.likes_count,
// every delete decrements it. Fires AFTER the API call succeeds — if the hook
// itself fails the favorite is still written, so a periodic reconcile job would
// be needed at scale. For homelab traffic this is fine.

onRecordAfterCreateRequest((e) => {
  const dao = $app.dao();
  const spotId = e.record.get("spot");
  if (!spotId) return;
  try {
    const spot = dao.findRecordById("spots", spotId);
    spot.set("likes_count", (spot.getInt("likes_count") || 0) + 1);
    dao.saveRecord(spot);
  } catch (err) {
    console.log("likes_count create-hook failed for spot=" + spotId + ": " + err);
  }
}, "favorites");

onRecordAfterDeleteRequest((e) => {
  const dao = $app.dao();
  const spotId = e.record.get("spot");
  if (!spotId) return;
  try {
    const spot = dao.findRecordById("spots", spotId);
    spot.set("likes_count", Math.max(0, (spot.getInt("likes_count") || 0) - 1));
    dao.saveRecord(spot);
  } catch (err) {
    console.log("likes_count delete-hook failed for spot=" + spotId + ": " + err);
  }
}, "favorites");
