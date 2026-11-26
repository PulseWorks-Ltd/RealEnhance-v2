jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { buildBareRoomTracePrompt } from "../src/pipeline/stage2Masked/core";

// Nov 2026, job_1268d850: every furniture trace drew a bedside table and its
// lampshade black; asking for the bare room instead found them.
describe("bare-room back-up trace", () => {
  const p = buildBareRoomTracePrompt("bedroom");
  it("asks for the room in white and the added furniture in black", () => {
    expect(p).toMatch(/WHITE = the bare room/);
    expect(p).toMatch(/BLACK = every piece of furniture/);
    expect(p).toMatch(/bedside tables, lamps and lampshades/);
  });
  it("keeps walls, doors, windows and hung art as room, never furniture", () => {
    expect(p).toMatch(/walls, ceiling, windows, doors/);
    expect(p).toMatch(/anything hung on walls \(artwork, mirrors\)/);
  });
  it("treats shadows as room and names the room type", () => {
    expect(p).toMatch(/Shadows on the floor or walls are WHITE/);
    expect(p).toMatch(/Room type: bedroom/);
  });
});
