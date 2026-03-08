import re
with open("worker/src/worker.ts") as f:
    lines = f.readlines()

for i, line in enumerate(lines[6800:8300]):
    if re.match(r'^ *(if|else|for|while|try|catch|const |let |var |await |unifiedValidation =|stage2Outcome =)', line) and len(line) < 100:
        print(f"{i+6801}: {line.strip()}")
