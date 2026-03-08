import re

with open("worker/src/worker.ts", "r") as f:
    text = f.read()

# Make assertNoDarkBorder in publishWithOptionalBlackEdgeGuard silently ignored
old_pub = r"""  const borderPx = Math.max(1, Number(process.env.BLACK_BORDER_CHECK_PX || 3));
  const threshold = Math.max(0, Number(process.env.BLACK_BORDER_THRESHOLD || 5));
  const maxDarkRatio = Math.max(0, Math.min(1, Number(process.env.BLACK_BORDER_MAX_DARK_RATIO || 0.02)));
  await assertNoDarkBorder(localPath, borderPx, threshold, maxDarkRatio);
  return publishImage(localPath);"""

new_pub = """  // Removed assertNoDarkBorder as per user request
  return publishImage(localPath);"""

text = text.replace(old_pub, new_pub)

# Make detectStage1ABorderOrCornerArtifact always return false
old_detect_func = r"async function detectStage1ABorderOrCornerArtifact\(imagePath: string\): Promise<boolean> \{"
new_detect_func = "async function detectStage1ABorderOrCornerArtifact(imagePath: string): Promise<boolean> {\n  return false; // Disabled by user request"

text = re.sub(old_detect_func, new_detect_func, text)

with open("worker/src/worker.ts", "w") as f:
    f.write(text)

