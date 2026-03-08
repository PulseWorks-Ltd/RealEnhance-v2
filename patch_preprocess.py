import re

with open("worker/src/pipeline/preprocess.ts", "r") as f:
    text = f.read()

# Remove detectBlackBorder
text = re.sub(
    r"async function detectBlackBorder\(imageBuffer: Buffer\): Promise<boolean> \{.+?^\}\n",
    "",
    text,
    flags=re.DOTALL | re.MULTILINE
)

# Remove cleanupBlackEdgeResiduals
text = re.sub(
    r"async function cleanupBlackEdgeResiduals\(.*?\): Promise<Buffer> \{.+?^\}\n",
    "",
    text,
    flags=re.DOTALL | re.MULTILINE
)

old_invoke_regex = r"let stage0ResultBuffer = await img\.toBuffer\(\);\s*if \(await detectBlackBorder\(stage0ResultBuffer\)\) \{\s*const recoveredImage = await cleanupBlackEdgeResiduals\(stage0ResultBuffer, options\.jobId\);\s*img = sharp\(recoveredImage\);\s*\}"

new_invoke = """let stage0ResultBuffer = await img.toBuffer();
  if (await detectBlackBorders(stage0ResultBuffer)) {
    let fixed = false;
    let currentBuffer = stage0ResultBuffer;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const meta = await sharp(currentBuffer).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w < 10 || h < 10) break;
      const cropW = Math.max(1, w - 4);
      const cropH = Math.max(1, h - 4);
      currentBuffer = await sharp(currentBuffer).extract({ left: 2, top: 2, width: cropW, height: cropH }).toBuffer();
      if (!(await detectBlackBorders(currentBuffer))) {
        fixed = true;
        break;
      }
    }
    if (fixed) {
      img = sharp(currentBuffer);
    } else {
      console.log(`[STRAIGHTEN_FALLBACK_ORIGINAL] jobId=${options.jobId || 'unknown'} reason=black_edges_after_stage0_rescue`);
      img = sharp(inputPath);
      img = img.rotate();
    }
  }"""

if re.search(old_invoke_regex, text):
    text = re.sub(old_invoke_regex, new_invoke, text)
else:
    print("Failed to find invoke block with regex.")

with open("worker/src/pipeline/preprocess.ts", "w") as f:
    f.write(text)

