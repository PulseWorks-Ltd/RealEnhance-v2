// The outlook survey retries once when the model call fails or times out.
jest.mock("../src/validators/validatorModelCall", () => ({ callValidatorModel: jest.fn() }));
import { callValidatorModel } from "../src/validators/validatorModelCall";
import { surveyExteriorOutlook } from "../src/validators/stage1AExteriorOutlookSurvey";

const call = callValidatorModel as jest.Mock;
const goodAnswer = { views: [{ box: [0.1, 0.2, 0.4, 0.5], blownOut: "no", hazy: "no", sky: "grey", greenery: "yes" }] };
const params = { imagePath: "x.jpg", jobId: "job", imageId: "img" };

describe("exterior outlook survey retry", () => {
  beforeEach(() => { call.mockReset(); jest.spyOn(console, "warn").mockImplementation(() => {}); });

  it("uses the second try when the first one times out", async () => {
    call.mockRejectedValueOnce(new Error('validator call "outlook_survey" timed out after 30000ms')).mockResolvedValueOnce(goodAnswer);
    const r = await surveyExteriorOutlook(params);
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.eligible).toBe(true);
    expect(r.skyToBlue).toBe(true);
  });

  it("does not call again after a good answer", async () => {
    call.mockResolvedValueOnce(goodAnswer);
    await surveyExteriorOutlook(params);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("gives up after two failed tries and says why", async () => {
    call.mockRejectedValue(new Error("timed out"));
    const r = await surveyExteriorOutlook(params);
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("after 2 tries");
  });
});
