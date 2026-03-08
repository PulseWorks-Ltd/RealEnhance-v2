import sys

with open('src/ai/compliance.ts', 'r') as f:
    text = f.read()

# We can replace structuralPrompt and placementPrompt with simpler versions
# that don't do structural validation. 
# Structural checks are now fully handled by the 3 new sequential validators.

structural_prompt_str = """  const structuralPrompt = [
    'Return JSON only: {\\\"ok\\\": true|false, \\\"confidence\\\": 0.0-1.0, \\\"reasons\\\": [\\\"...\\\"]}',
    ...stage2Context,
    'Compare ORIGINAL vs EDITED. Ignore structural changes (those are handled elsewhere).',
    'ok=false ONLY if there are severe rendering artifacts, unnatural warping, or glitches.',
    'Confidence scale: 0.9–1.0 = very certain violation, 0.7–0.9 = likely violation, 0.4–0.7 = uncertain, <0.4 = weak signal',
  ].join("\\n");"""

placement_prompt_str = """  const placementPrompt = [
    'Return JSON only: {\\\"ok\\\": true|false, \\\"confidence\\\": 0.0-1.0, \\\"reasons\\\": [\\\"...\\\"]}',
    ...stage2Context,
    'Compare ORIGINAL vs EDITED. ok=false ONLY if EDITED places objects in clearly unrealistic or unsafe positions, such as:',
    '- floating furniture,',
    '- furniture not aligned to floor perspective,',
    '- furniture inappropriately passing through other objects.',
    'Ignore structural architecture (like walls, windows, fixtures), that is handled elsewhere.',
    'Confidence scale: 0.9–1.0 = very certain violation, 0.7–0.9 = likely violation, 0.4–0.7 = uncertain, <0.4 = weak signal',
  ].join("\\n");"""

import re
import math

# Use regex to replace the old prompts

text = re.sub(
    r'const structuralPrompt = \[.*?\]\.join\("\\n"\);',
    structural_prompt_str,
    text,
    flags=re.DOTALL
)

text = re.sub(
    r'const placementPrompt = \[.*?\]\.join\("\\n"\);',
    placement_prompt_str,
    text,
    flags=re.DOTALL
)

with open('src/ai/compliance.ts', 'w') as f:
    f.write(text)

