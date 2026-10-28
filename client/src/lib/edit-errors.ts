// A failed edit leaves the card's image as it was; this is the note shown on
// the card. The worker's reason (whole-image edits) is turned into plain words.
export function friendlyEditError(raw: unknown): string {
  const msg = String(raw || "").toLowerCase();
  const tail = " Your image hasn't been changed.";
  if (/mostly outside the marked area|runs far past the marked area|runs past the marked area/.test(msg)) {
    return "The edit couldn't fit the item in the area you marked. Try marking a larger area." + tail;
  }
  if (/around the (item|new piece) changed|room around the new piece changed|room reshaped|room moved/.test(msg)) {
    return "The edit changed more of the room than the area you marked, so it wasn't applied. Please try again." + tail;
  }
  if (/nothing changed inside the marked area/.test(msg)) {
    return "The edit didn't change the area you marked. Try describing the change differently." + tail;
  }
  return "The edit couldn't be completed. Please try again." + tail;
}
