import re

with open("worker/src/pipeline/preprocess.ts", "r") as f:
    text = f.read()

old_block = r"""  let stage0ResultBuffer = await img\.toBuffer\(\);
  if \(await detectBlackBorders\(stage0ResultBuffer\)\) \{
    let fixed = false;
    let currentBuffer = stage0ResultBuffer;
    for \(let attempt = 1; attempt <= 2; attempt\+\+\) \{
      const meta = await sharp\(currentBuffer\)\.metadata\(\);
      const w = meta\.width \|\| 0;
      const h = meta\.height \|\| 0;
      if \(w < 10 \|\| h < 10\) break;
      const cropW = Math\.max\(1, w - 4\);
      const cropH = Math\.max\(1, h - 4\);
      currentBuffer = await sharp\(currentBuffer\)\.extract\(\{ left: 2, top: 2, width: cropW, height: cropH \}\)\.toBuffer\(\);
      if \(!\(await detectBlackBorders\(currentBuffer\)\)\) \{
        fixed = true;
        break;
      \}
    \}
    if \(fixed\) \{
      img = sharp\(currentBuffer\);
    \} else \{
      console\.log\(`\[STRAIGHTEN_FALLBACK_ORIGINAL\] jobId=\$\{options\.jobId \|\| 'unknown'\} reason=black_edges_after_stage0_rescue`\);
      img = sharp\(inputPath\);
      img = img\.rotate\(\);
    \}
  \}"""

new_block = """  let stage0ResultBuffer = await img.toBuffer();
  console.log(`[STRAIGHTEN_ATTEMPT] jobId=${options.jobId || 'unknown'}`);
  if (await detectBlackBorders(stage0ResultBuffer)) {
    console.log(`[BLACK_BORDER_DETECTED] jobId=${options.jobId || 'unknown'}`);
    let fixed = false;
    let currentBuffer = stage0ResultBuffer;
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[CROP_RETRY_${attempt}] jobId=${options.jobId || 'unknown'}`);
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
      console.log(`[STRAIGHTEN_SKIPPED] jobId=${options.jobId || 'unknown'}`);
      img = sharp(inputPath);
      img = img.rotate();
    }
  }"""

if re.search(old_block, text):
    text = re.sub(old_block, new_block, text)
else:
    print("Could not find the block.")

with open("worker/src/pipeline/preprocess.ts", "w") as f:
    f.write(text)

