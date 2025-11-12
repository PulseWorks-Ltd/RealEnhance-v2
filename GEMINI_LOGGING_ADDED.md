# Gemini Logging Added

## Summary
Added comprehensive logging throughout the Gemini AI enhancement pipeline to diagnose whether images are actually being processed by Gemini API or if they're falling back to Sharp-only processing.

## Changes Made

### 1. Reverted Prompt Changes
- **File**: `worker/src/ai/gemini.ts`
- **Action**: Reverted the "dramatic enhancement" prompt back to the original balanced version
- **Reason**: User suspects the issue is not with the prompt, but with images not reaching Gemini at all

### 2. Enhanced Gemini Function Logging
**File**: `worker/src/ai/gemini.ts` - `enhanceWithGemini()` function

Added detailed logging at every step:
- 🔵 **Start**: Input path and options
- ✓ **Client init**: Gemini client initialization
- 🖼️ **Image load**: File size in KB after reading from disk
- 📦 **Base64 encoding**: Encoded size in KB
- 📝 **Prompt generation**: Prompt length and preview
- 🤖 **Model init**: Which Gemini model is being used
- 🚀 **API call**: When calling Gemini with image size and prompt length
- ✅ **API response**: Time elapsed in milliseconds
- 📊 **Response validation**: Number of candidates and parts
- 🔍 **Part inspection**: Checking each part for inline image data
- ✓ **Success markers**: Found image data with size
- 💾 **File save**: Output path where enhanced image is saved
- 🎉 **Completion**: Final success message
- ❌ **Errors**: Detailed error logging with full response/part dumps

**Key diagnostic logs added:**
```typescript
console.log(`[Gemini] 🖼️ Loaded image from disk: ${imageSizeKB} KB`);
console.log(`[Gemini] 📦 Encoded to base64: ${base64SizeKB} KB`);
console.log(`[Gemini] 🚀 Calling Gemini API...`);
console.log(`[Gemini] ✅ Gemini API responded in ${elapsedMs} ms`);
console.log(`[Gemini] 📊 Response candidates: ${candidates?.length || 0}`);
console.log(`[Gemini] 🔍 Checking part ${i}:`, Object.keys(part));
console.log(`[Gemini] ✓ Found inline image data in part ${i}: ${dataSizeKB} KB`);
```

**Error logging:**
- If no candidates: Logs full response JSON
- If no parts: Logs candidate JSON
- If no image data: Logs all parts JSON
- Catches and logs all exceptions with details

### 3. Enhanced Stage1A Logging
**File**: `worker/src/pipeline/stage1A.ts`

Already had good logging, kept existing:
- When Gemini is skipped (declutter mode)
- When Gemini is called (enhance-only mode)
- Success/fallback messages

### 4. Enhanced Stage1B Logging
**File**: `worker/src/pipeline/stage1B.ts`

Added comprehensive logging:
- 🔵 **Start**: Input path and options
- 🤖 **Gemini call**: Indicating COMBINED enhance+declutter prompt
- 📊 **Response check**: Gemini return path
- 🔍 **Success validation**: Whether Gemini succeeded (different path returned)
- 💾 **File operations**: Renaming operations
- ✅ **Success/Fallback**: Clear indicators

**Key logs:**
```typescript
console.log(`[stage1B] 🔵 Starting combined Gemini enhance+declutter...`);
console.log(`[stage1B] Input (Stage1A): ${stage1APath}`);
console.log(`[stage1B] 🤖 Calling Gemini with COMBINED enhance+declutter prompt...`);
console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
console.log(`[stage1B] ✅ SUCCESS - Combined enhance+declutter complete`);
```

### 5. Enhanced Stage2 Logging
**File**: `worker/src/pipeline/stage2.ts`

Added comprehensive logging:
- 🔵 **Start**: Input path, room type, profile
- ⚠️ **Early exits**: When stage2 disabled or no API key
- 🤖 **API call**: Before calling Gemini
- 📝 **Prompt info**: Prompt length
- ✅ **API response**: Time elapsed
- 📊 **Response validation**: Number of parts
- ❌ **Errors**: Full error details and response dumps
- 💾 **File save**: Output path
- 🎉 **Success**: Completion message

**Key logs:**
```typescript
console.log(`[stage2] 🔵 Starting virtual staging...`);
console.log(`[stage2] Input (Stage1B): ${basePath}`);
console.log(`[stage2] 🤖 Calling Gemini API for virtual staging...`);
console.log(`[stage2] ✅ Gemini API responded in ${apiElapsed} ms`);
console.log(`[stage2] 📊 Response parts: ${responseParts.length}`);
console.log(`[stage2] 🎉 SUCCESS - Virtual staging complete`);
```

## Diagnostic Flow

With this logging, you can now trace:

1. **Image Journey**:
   - Worker receives job → logs input path
   - Stage1A: Sharp processing → Gemini enhancement (if enhance-only)
   - Stage1B: Gemini combined enhancement+declutter (if declutter requested)
   - Stage2: Gemini virtual staging (if requested)

2. **Gemini API Success/Failure**:
   - Each Gemini call logs: start, API call, response time, validation
   - If Gemini returns NO IMAGE: logs full response structure
   - If Gemini FAILS: logs exception details

3. **Fallback Detection**:
   - Clear markers when using Sharp-only vs Gemini-enhanced
   - Success validation: `YES ✅` or `NO ❌`

## Expected Log Patterns

### SUCCESS (Gemini working):
```
[Gemini] 🔵 Input path: /path/to/image.webp
[Gemini] 🖼️ Loaded image from disk: 450 KB
[Gemini] 📦 Encoded to base64: 600 KB
[Gemini] 🚀 Calling Gemini API...
[Gemini] ✅ Gemini API responded in 3500 ms
[Gemini] 📊 Response candidates: 1
[Gemini] ✓ Found 2 part(s) in response
[Gemini] ✓ Found inline image data in part 1: 520 KB
[Gemini] 💾 Saved enhanced image to: /path/to/image-gemini-enhanced.webp
[Gemini] 🎉 SUCCESS - Enhanced image ready
```

### FAILURE (Gemini not working):
```
[Gemini] 🔵 Input path: /path/to/image.webp
[Gemini] 🖼️ Loaded image from disk: 450 KB
[Gemini] 📦 Encoded to base64: 600 KB
[Gemini] 🚀 Calling Gemini API...
[Gemini] ✅ Gemini API responded in 2000 ms
[Gemini] 📊 Response candidates: 1
[Gemini] ✓ Found 1 part(s) in response
[Gemini] 🔍 Checking part 0: ['text']  ← NO inlineData!
[Gemini] ❌ ERROR: No image data found in any part!
[Gemini] All parts: [{"text":"Sorry, I cannot..."}]
⚠️ No image data in Gemini response, using original image
```

## What to Look For

When testing with virtual staging (Stage 2), check logs for:

1. ✅ **Stage2 is being called**: Should see `[stage2] 🔵 Starting virtual staging...`
2. ✅ **Gemini API is called**: Should see `[stage2] 🤖 Calling Gemini API...`
3. ✅ **Response contains image**: Should see `[stage2] ✓ Found staged image in response`
4. ❌ **No image returned**: Would see `[stage2] ❌ ERROR: No image data in Gemini response!`

If you're NOT getting furniture added in Stage2, the logs will show exactly where the failure occurs.

## Next Steps

1. Deploy worker with these logging changes
2. Run a full enhancement with virtual staging enabled
3. Check Railway worker logs for the diagnostic output
4. Share the logs to identify exactly where Gemini is failing or returning text instead of images
