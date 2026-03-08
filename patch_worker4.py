import re

with open("worker/src/worker.ts", "r") as f:
    text = f.read()

# Replace entire detectStage1ABorderOrCornerArtifact function body
pattern = r"async function detectStage1ABorderOrCornerArtifact\(imagePath: string\): Promise<boolean> \{.+?return cornerScan\.detected;\n\}"

replacement = """async function detectStage1ABorderOrCornerArtifact(imagePath: string): Promise<boolean> {
  return false; // Disabled by user request
}"""

if re.search(pattern, text, flags=re.DOTALL):
    text = re.sub(pattern, replacement, text, flags=re.DOTALL)
else:
    print("Could not find detectStage1ABorderOrCornerArtifact")

with open("worker/src/worker.ts", "w") as f:
    f.write(text)
