import { buildStage1AInteriorPromptNZStandard, buildStage1AInteriorPromptNZHighEnd } from "../prompts.nzInterior";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle, buildStage2PromptNZStyle } from "../prompts.nzRealEstate";

describe("prompt pixel dimension requirements", () => {
  const phrase = "same pixel dimensions";

  test("Stage 1A prompts include pixel dimension clause", () => {
    const standard = buildStage1AInteriorPromptNZStandard("living room");
    const highEnd = buildStage1AInteriorPromptNZHighEnd("living room");
    expect(standard).toContain(phrase);
    expect(highEnd).toContain(phrase);
  });

  test("Stage 1B interior declutter prompts include pixel dimension clause", () => {
    const full = buildStage1BPromptNZStyle("bedroom", "interior");
    const light = buildLightDeclutterPromptNZStyle("bedroom", "interior");
    expect(full).toContain(phrase);
    expect(light).toContain(phrase);
  });

  test("Stage 1B exterior declutter prompt includes pixel dimension clause", () => {
    const exterior = buildStage1BPromptNZStyle("deck", "exterior");
    expect(exterior).toContain(phrase);
  });

  test("Stage 2 prompts include pixel dimension clause (interior and exterior)", () => {
    const interior = buildStage2PromptNZStyle("kitchen", "interior");
    const exterior = buildStage2PromptNZStyle("patio", "exterior");
    expect(interior).toContain(phrase);
    expect(exterior).toContain(phrase);
  });
});
