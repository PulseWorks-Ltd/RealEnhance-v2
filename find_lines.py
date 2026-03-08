import re
with open("worker/src/worker.ts") as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if "await runStructuralTopologyCheck(" in line:
        print(f"topology: {i}")
    if "await runFixtureValidator(" in line:
        print(f"fixture: {i}")
    if "await validateOpeningPreservation(" in line:
        print(f"validateOpening: {i}")
    if "await runStructuralInvariantGeminiCheck(" in line:
        print(f"invariant: {i}")
    if "await runUnifiedValidation(params" in line or "await runUnifiedValidation({" in line:
        print(f"unified: {i}")

