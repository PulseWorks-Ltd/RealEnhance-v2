// Regression tests for the blocking-flag helpers in validatorModelCall.ts.
// newValidatorChecksBlocking() gates windowArtworkCheck/vanishedLandmarkCheck
// and (RealEnhance audit fixes C2/C3) their new siblings
// fabricatedFixtureCheck/doorArtworkCheck. doorAccessClearanceCheckBlocking()
// (fix H1) is deliberately a SEPARATE, independently-defaulted flag — this
// suite exists specifically to prove the two never accidentally collapse
// into reading the same env var.
describe("validator check blocking flags", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEW_VALIDATOR_CHECKS_BLOCKING;
    delete process.env.DOOR_ACCESS_CLEARANCE_CHECK_BLOCKING;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("newValidatorChecksBlocking defaults to false when unset", () => {
    const { newValidatorChecksBlocking } = require("../src/validators/validatorModelCall");
    expect(newValidatorChecksBlocking()).toBe(false);
  });

  it("newValidatorChecksBlocking requires the exact string 'true' (case-insensitive, trimmed) — '1'/'yes' do not count", () => {
    const mod = require("../src/validators/validatorModelCall");
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "1";
    expect(mod.newValidatorChecksBlocking()).toBe(false);
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "TRUE";
    expect(mod.newValidatorChecksBlocking()).toBe(true);
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "  true  ";
    expect(mod.newValidatorChecksBlocking()).toBe(true);
  });

  it("doorAccessClearanceCheckBlocking defaults to false when unset, independent of NEW_VALIDATOR_CHECKS_BLOCKING", () => {
    const { doorAccessClearanceCheckBlocking } = require("../src/validators/validatorModelCall");
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "true";
    expect(doorAccessClearanceCheckBlocking()).toBe(false);
  });

  it("doorAccessClearanceCheckBlocking responds only to its OWN env var, not NEW_VALIDATOR_CHECKS_BLOCKING", () => {
    const { doorAccessClearanceCheckBlocking } = require("../src/validators/validatorModelCall");
    process.env.DOOR_ACCESS_CLEARANCE_CHECK_BLOCKING = "true";
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "false";
    expect(doorAccessClearanceCheckBlocking()).toBe(true);
  });

  it("the two flags are fully independent in both directions", () => {
    const mod = require("../src/validators/validatorModelCall");
    process.env.NEW_VALIDATOR_CHECKS_BLOCKING = "true";
    process.env.DOOR_ACCESS_CLEARANCE_CHECK_BLOCKING = "false";
    expect(mod.newValidatorChecksBlocking()).toBe(true);
    expect(mod.doorAccessClearanceCheckBlocking()).toBe(false);
  });
});
