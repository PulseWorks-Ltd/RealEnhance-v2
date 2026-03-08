import re

with open("worker/src/worker.ts", "r") as f:
    content = f.read()

# Second replace: removing the retry loop for Stage1A
start_marker = "  let stage1ABlackArtifactDetected = false;\n"
end_regex = r"    return;\n  \}\n"

start_idx = content.find(start_marker)
match = re.search(end_regex, content[start_idx:])
if start_idx != -1 and match:
    end_idx = start_idx + match.end()
    
    new_loop = """  path1A = await runStage1A(canonicalPath, {
    replaceSky: safeReplaceSky,
    declutter: false, // Never declutter in Stage 1A - that's Stage 1B's job
    sceneType: sceneLabel,
    interiorProfile: ((): any => {
      const p = (payload.options as any)?.interiorProfile;
      if (p === 'nz_high_end' || p === 'nz_standard') return p;
      return undefined;
    })(),
    skyMode: skyModeForStage1A,
    jobId: payload.jobId,
    roomType: payload.options.roomType,
    baseArtifacts: jobContext.baseArtifacts,
    baseArtifactsCache: jobContext.baseArtifactsCache,
    jobSampling: jobContext.jobSampling,
  });\n"""
    content = content[:start_idx] + new_loop + content[end_idx:]
else:
    print("Could not find Stage 1A retry loop")

with open("worker/src/worker.ts", "w") as f:
    f.write(content)
