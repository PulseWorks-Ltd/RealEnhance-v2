# Gemini API Fix - Updated to v0.7.0

## Problem

Worker was crashing with error:
```
[Gemini] EXCEPTION: Gemini Enhance failed: TypeError: client.getGenerativeModel is not a function
```

## Root Cause

The `@google/genai` package was updated from an older version to v0.7.0, which introduced **breaking API changes**. The old API used:

```typescript
// OLD API (no longer works)
const model = client.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
const result = await model.generateContent([...]);
const response = await result.response;
```

The new v0.7.0 API uses:

```typescript
// NEW API (v0.7.0+)
const result = await client.models.generateContent({
  model: "gemini-2.0-flash",
  contents: [...]
});
// result is the response directly (no .response property)
```

## Changes Made

### File: `worker/src/ai/gemini.ts`

1. **Removed model initialization step:**
   ```typescript
   // OLD: const model = client.getGenerativeModel(...)
   // NEW: Call client.models.generateContent() directly
   ```

2. **Updated API call structure:**
   - Changed from `model.generateContent([...])` to `client.models.generateContent({ model, contents })`
   - Wrapped content in proper structure with `role: "user"` and `parts` array
   - Updated model name from `gemini-1.5-pro-latest` to `gemini-2.5-flash`

3. **Simplified response handling:**
   ```typescript
   // OLD: const response = await result.response;
   // NEW: result is the response directly
   ```

4. **Added debug logging:**
   - Added `console.log` to show response structure for debugging
   - Updated error messages to reference `result` instead of `response`

## Testing

Build completed successfully:
```bash
cd worker && pnpm run build
# ✅ No compilation errors
```

## Next Steps

1. **Deploy the updated worker** to Railway or your production environment
2. **Test with an image** that has Gemini enhancement enabled
3. **Check logs** for successful Gemini processing:
   ```
   [Gemini] ✓ Gemini client initialized
   [Gemini] 🚀 Calling Gemini API...
   [Gemini] ✅ Gemini API responded in XXX ms
   [Gemini] 📊 Response structure: [...]
   [Gemini] ✓ Found X candidate(s)
   [Gemini] ✓ Found inline image data
   [Gemini] 💾 Saved enhanced image to: ...
   ```

## API Reference

For the new API documentation, see:
- Package README: https://github.com/googleapis/js-genai
- Official docs: https://googleapis.github.io/js-genai/

## Migration Notes

If you have other code using the Gemini API:

**Before (old API):**
```typescript
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
const result = await model.generateContent(prompt);
const response = await result.response;
const text = response.text();
```

**After (new API v0.7.0):**
```typescript
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey });
const result = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: prompt
});
const text = result.text;
```

## Additional Changes

- Model name updated to `gemini-2.5-flash` (latest Gemini 2.0 model)
- Content structure now requires explicit `role` and `parts` structure
- Response is returned directly (no intermediate `.response` property)
