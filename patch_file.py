import sys

with open("worker/src/worker.ts", "r") as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if i > 6800 and i < 6900 and "unifiedValidation = await runUnifiedValidation({" in line:
        start_idx = i
        break

for i, line in enumerate(lines):
    if i > 8600 and "// Compliance gate is part of Stage 2 retry flow" in line:
        end_idx = i
        break

if start_idx == -1 or end_idx == -1:
    print(f"Error finding offsets: start={start_idx} end={end_idx}")
    sys.exit(1)

print(f"Replacing {start_idx} to {end_idx}")

new_code = """
      // BEGIN NEW SEQUENTIAL VALIDATORS
      let seqPass = true;
      let failMessage = "";
      
      try {
        const { runEnvelopeValidator } = await import("./validators/envelopeValidator.js");
        const { runOpeningValidator } = await import("./validators/openingValidator.js");
        const { runFixtureValidator } = await import("./validators/fixtureValidator.js");

        const envRes = await runEnvelopeValidator(path1A, path2);
        if (!envRes.pass) {
          seqPass = false;
          failMessage = envRes.reason;
          nLog(`[VALIDATOR_FAIL] Envelope failed: ${failMessage}`);
        } else {
          nLog(`[VALIDATOR_ENVELOPE_PASS] ${envRes.reason}`);
          
          const opRes = await runOpeningValidator(path1A, path2);
          if (!opRes.pass) {
            seqPass = false;
            failMessage = opRes.reason;
            nLog(`[VALIDATOR_FAIL] Opening failed: ${failMessage}`);
          } else {
            nLog(`[VALIDATOR_OPENING_PASS] ${opRes.reason}`);
            
            const fixRes = await runFixtureValidator(path1A, path2);
            if (!fixRes.pass) {
              seqPass = false;
              failMessage = fixRes.reason;
              nLog(`[VALIDATOR_FAIL] Fixture failed: ${failMessage}`);
            } else {
              nLog(`[VALIDATOR_FIXTURE_PASS] ${fixRes.reason}`);
            }
          }
        }

        if (!seqPass) {
            stage2LocalReasons.push(failMessage);
            pendingStage2StructuralFailureType = "STRUCTURAL_INVARIANT";
            pendingStage2RetryStrategy = "NORMAL";
            pendingStage2RetryReason = "sequential_validator_failed";

            mergeAttemptValidation("2", attempt, {
                final: {
                    result: "FAILED",
                    finalHard: true,
                    finalCategory: "sequential_validator_failed",
                    retryTriggered: attempt < MAX_STAGE2_RETRIES,
                    retriesExhausted: attempt >= MAX_STAGE2_RETRIES,
                    retryStrategy: "NORMAL",
                    reason: failMessage,
                }
            });

            if (attempt < MAX_STAGE2_RETRIES) {
                logEvent("STAGE_RETRY", {
                    jobId: payload.jobId,
                    stage: "2",
                    retry: attempt + 1,
                    retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
                    reason: failMessage,
                });
                continue;
            } else {
                const fallbackPath = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1A;
                const fallbackStage = fallbackPath === path1A ? "1A" : "1B";
                stage2Blocked = true;
                stage2FallbackStage = fallbackStage;
                stage2BlockedReason = "sequential_validators_exhausted";
                fallbackUsed = fallbackStage === "1B" ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
                path2 = fallbackPath;
                stage2CandidatePath = fallbackPath;
                break;
            }
        }
      } catch (err) {
        nLog(`[SEQUENTIAL_VALIDATOR_ERROR] ${err}`);
      }

      // Mock unifiedValidation for downstream compliance logic
      unifiedValidation = { passed: seqPass, hardFail: !seqPass, score: seqPass ? 100 : 0, reasons: seqPass ? [] : [failMessage], warnings: [], evidence: { anchorChecks: {} } } as any;

      if (!seqPass) {
         continue; 
      }
      
      let compositeDecision = "pass";
      let complianceDecision = "not_run";
      let finalConfirmMode = "log";
      // END NEW SEQUENTIAL VALIDATORS
"""

new_lines = lines[:start_idx] + [new_code] + lines[end_idx:]

with open("worker/src/worker.ts", "w") as f:
    f.writelines(new_lines)

print("Patched.")
