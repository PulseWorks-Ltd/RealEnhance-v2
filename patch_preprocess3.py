import re

with open("worker/src/pipeline/preprocess.ts", "r") as f:
    text = f.read()

# Remove BLACK_BORDER_STAGE1A_FATAL check
old_catch = r"""  \} catch \(error: any\) \{
    if \(error\?\.message === "BLACK_BORDER_STAGE1A_FATAL"\) \{
      throw error;
    \}
    return \{"""

new_catch = r"""  } catch (error: any) {
    return {"""

text = re.sub(old_catch, new_catch, text)

with open("worker/src/pipeline/preprocess.ts", "w") as f:
    f.write(text)

