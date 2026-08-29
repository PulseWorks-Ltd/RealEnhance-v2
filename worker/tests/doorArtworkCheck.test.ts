// Regression tests for evaluateArtworkOnDoorSurface / isDoorArtworkCheckApplicable
// (RealEnhance audit fix C3 — Part C of tmp/implausibleStagingCheck.ts,
// explicitly left out of windowArtworkCheck.ts's original integration).
// Pure, synchronous functions — no network calls, no mocking needed.
import { evaluateArtworkOnDoorSurface, isDoorArtworkCheckApplicable } from "../src/validators/doorArtworkCheck";

describe("isDoorArtworkCheckApplicable", () => {
  it("applies to door and closet_door", () => {
    expect(isDoorArtworkCheckApplicable("door")).toBe(true);
    expect(isDoorArtworkCheckApplicable("closet_door")).toBe(true);
  });

  it("does not apply to window or walkthrough", () => {
    expect(isDoorArtworkCheckApplicable("window")).toBe(false);
    expect(isDoorArtworkCheckApplicable("walkthrough")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDoorArtworkCheckApplicable("DOOR")).toBe(true);
  });
});

describe("evaluateArtworkOnDoorSurface (C3 fix)", () => {
  it("is not_applicable for a non-door item type regardless of observation content", () => {
    const result = evaluateArtworkOnDoorSurface("window", undefined, {
      doorSurfaceDescription: "irrelevant",
      doorSurfaceType: "glass_panes",
      mountedArtworkDescription: "a framed canvas",
      artworkMountedOnDoor: "yes",
    });
    expect(result.verdict).toBe("not_applicable");
  });

  it("is not_applicable for a plain flush solid door with no special-surface evidence anywhere — a wreath or hanging decoration on an ordinary door is normal staging", () => {
    const result = evaluateArtworkOnDoorSurface("door", "A plain white painted solid door.", {
      doorSurfaceDescription: "A plain flush solid wooden door.",
      doorSurfaceType: "flush_solid",
      mountedArtworkDescription: "A small seasonal wreath hangs on the door.",
      artworkMountedOnDoor: "yes",
    });
    expect(result.verdict).toBe("not_applicable");
  });

  it("fails when the fresh observation confirms a glass-paned door with artwork mounted directly on its own leaf", () => {
    const result = evaluateArtworkOnDoorSurface("door", "A glass-paned door leading to the study.", {
      doorSurfaceDescription: "The door's glass panes are now covered by a large framed canvas print mounted directly on the leaf.",
      doorSurfaceType: "glass_panes",
      mountedArtworkDescription: "A large framed abstract canvas print, attached directly to the door's own panel.",
      artworkMountedOnDoor: "yes",
    });
    expect(result.verdict).toBe("fail_artwork_on_door_surface");
    expect(result.reason).toContain("glass_panes");
  });

  it("fails when only the BASELINE description indicates a mirror panel, even if the fresh observation can't tell (the artwork may itself now obscure the mirror surface)", () => {
    const result = evaluateArtworkOnDoorSurface("closet_door", "A mirrored sliding closet door.", {
      doorSurfaceDescription: "Cannot clearly see the door's own surface material — a large picture frame covers most of it.",
      doorSurfaceType: "cannot_tell",
      mountedArtworkDescription: "A large framed print hangs over the door's leaf, obscuring most of its surface.",
      artworkMountedOnDoor: "yes",
    });
    expect(result.verdict).toBe("fail_artwork_on_door_surface");
    expect(result.reason).toContain("baselineIndicatesSpecialSurface=true");
  });

  it("passes (applicable, not confirmed) when the door is sliding but nothing is mounted on it", () => {
    const result = evaluateArtworkOnDoorSurface("door", "A sliding pocket door.", {
      doorSurfaceDescription: "A closed sliding door with a visible track above.",
      doorSurfaceType: "sliding_panel",
      mountedArtworkDescription: "Nothing is mounted on the door's own leaf.",
      artworkMountedOnDoor: "no",
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes (applicable, cannot_tell) rather than failing on an ambiguous read", () => {
    const result = evaluateArtworkOnDoorSurface("door", "A glass-paned door.", {
      doorSurfaceDescription: "Partially obscured by furniture in front of it.",
      doorSurfaceType: "glass_panes",
      mountedArtworkDescription: "Cannot tell if anything is mounted on the door itself.",
      artworkMountedOnDoor: "cannot_tell",
    });
    expect(result.verdict).toBe("pass");
  });

  it("does not misfire on ordinary furniture merely standing in front of a glass door (not mounted on its leaf)", () => {
    const result = evaluateArtworkOnDoorSurface("door", "A glass-paned door.", {
      doorSurfaceDescription: "A bookshelf stands in front of the door, not attached to it.",
      doorSurfaceType: "glass_panes",
      mountedArtworkDescription: "Nothing is attached to or hanging from the door's own leaf; the bookshelf merely stands nearby.",
      artworkMountedOnDoor: "no",
    });
    expect(result.verdict).toBe("pass");
  });
});
