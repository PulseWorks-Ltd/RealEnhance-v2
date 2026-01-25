import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from server/.env
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const apiKey = process.env.REALENHANCE_API_KEY || process.env.GOOGLE_API_KEY;

// Use a capable model for reasoning about prompts
const modelId = process.env.VERTEX_MODEL_ID || 'gemini-2.5-flash';

let ai: GoogleGenAI;

if (apiKey) {
  console.log(`Configuration: Using API Key (Google AI Studio) | Model=${modelId}`);
  ai = new GoogleGenAI({ apiKey });
} else if (projectId) {
  console.log(`Configuration: Using Vertex AI | Project=${projectId}, Location=${location}, Model=${modelId}`);
  ai = new GoogleGenAI({ vertexai: true, project: projectId, location: location });
} else {
  console.error('Error: Authentication missing. Set REALENHANCE_API_KEY (API Key) or GOOGLE_CLOUD_PROJECT (Vertex) in server/.env');
  process.exit(1);
}

async function reviewPrompt(promptText: string) {
  console.log(`\n🤖 Analyzing prompt using Gemini (${modelId})...\n`);

  const metaPrompt = `
    You are an expert Prompt Engineer and AI Researcher. 
    Your task is to critique and improve the following prompt intended for a Large Language Model (Gemini).

    Please provide a structured review:
    
    1. **Strength Assessment**: What does this prompt do well? (e.g., clear persona, good constraints)
    2. **Weakness Identification**: Are there ambiguities, missing context, or potential for hallucinations?
    3. **Optimization Suggestions**: Specific changes to make the prompt more robust, deterministic, or effective.
    4. **Rewritten Prompt**: A polished, ready-to-use version of the prompt incorporating your best practices.

    ---
    ORIGINAL PROMPT TO REVIEW:
    ${promptText}
    ---
  `;

  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: metaPrompt,
    });

    if (response.text) {
      console.log('============================================================');
      console.log('PROMPT REVIEW RESULTS');
      console.log('============================================================\n');
      console.log(response.text);
      console.log('\n============================================================');
    } else {
      console.log('No response text received from the model.');
    }
  } catch (error) {
    console.error('Failed to review prompt:', error);
    console.error('\n❌ FAILED to review prompt.');
    console.error('Error details:', error);
    console.error('\nTroubleshooting:');
    console.error('1. If using Vertex: Run "gcloud auth application-default login" (requires gcloud CLI)');
    console.error('2. If using API Key: Ensure REALENHANCE_API_KEY is valid in server/.env');
    console.error('3. Check if model name is correct for the selected provider.');
    console.error('   Try setting VERTEX_MODEL_ID="gemini-2.0-flash" in server/.env if gemini-2.5-flash is unavailable.');
  }
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.log('Usage: npx tsx review-prompt-vertex.ts "<prompt string>"');
    console.log('   OR: npx tsx review-prompt-vertex.ts <path/to/prompt/file>');
    return;
  }

  let promptContent = input;

  // Check if input is a file path
  if (fs.existsSync(input)) {
    try {
      promptContent = fs.readFileSync(input, 'utf-8');
      console.log(`Loaded prompt from file: ${input}`);
    } catch (e) {
      console.error(`Error reading file: ${input}`, e);
      return;
    }
  }

  await reviewPrompt(promptContent);
}

main();