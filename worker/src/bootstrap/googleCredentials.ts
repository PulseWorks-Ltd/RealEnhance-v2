import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { nLog } from "../logger";

const DEFAULT_GOOGLE_CREDENTIALS_PATH = "/tmp/gcp-key.json";

export type GoogleCredentialsBootstrapResult = {
  credentialsPath: string;
  fileExists: boolean;
  bootstrapMs: number;
  jsonParseSuccess: boolean;
};

export function getGoogleCredentialsPath(): string {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_GOOGLE_CREDENTIALS_PATH).trim()
    || DEFAULT_GOOGLE_CREDENTIALS_PATH;
}

export function googleCredentialsFileExists(credentialsPath = getGoogleCredentialsPath()): boolean {
  return existsSync(credentialsPath);
}

export function assertGoogleCredentialsFileReadySync(credentialsPath = getGoogleCredentialsPath()): void {
  if (!googleCredentialsFileExists(credentialsPath)) {
    throw new Error(`Vertex ADC credentials file missing at ${credentialsPath}`);
  }
}

export async function bootstrapGoogleCredentialsFromEnv(): Promise<GoogleCredentialsBootstrapResult> {
  const startedAt = Date.now();
  const credentialsPath = getGoogleCredentialsPath();
  const rawCredentialsJson = String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim();

  nLog("[VERTEX_AUTH_BOOTSTRAP]", {
    credentialsPath,
    fileExistsBeforeBootstrap: googleCredentialsFileExists(credentialsPath),
    hasCredentialsJsonEnv: rawCredentialsJson.length > 0,
  });

  if (!rawCredentialsJson) {
    const bootstrapMs = Date.now() - startedAt;
    nLog("[VERTEX_AUTH_FAILURE]", {
      credentialsPath,
      fileExists: googleCredentialsFileExists(credentialsPath),
      bootstrapMs,
      jsonParseSuccess: false,
      reason: "missing_google_application_credentials_json",
    });
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is required for Vertex experimental worker bootstrap");
  }

  let parsedCredentials: unknown;
  try {
    parsedCredentials = JSON.parse(rawCredentialsJson);
  } catch (error: any) {
    const bootstrapMs = Date.now() - startedAt;
    nLog("[VERTEX_AUTH_FAILURE]", {
      credentialsPath,
      fileExists: googleCredentialsFileExists(credentialsPath),
      bootstrapMs,
      jsonParseSuccess: false,
      reason: error?.message || "credentials_json_parse_failed",
    });
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${error?.message || error}`);
  }

  try {
    await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
    await fs.writeFile(credentialsPath, JSON.stringify(parsedCredentials));
    await fs.chmod(credentialsPath, 0o600);
    await fs.access(credentialsPath);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  } catch (error: any) {
    const bootstrapMs = Date.now() - startedAt;
    nLog("[VERTEX_AUTH_FAILURE]", {
      credentialsPath,
      fileExists: googleCredentialsFileExists(credentialsPath),
      bootstrapMs,
      jsonParseSuccess: true,
      reason: error?.message || "credentials_file_write_failed",
    });
    throw error;
  }

  const result: GoogleCredentialsBootstrapResult = {
    credentialsPath,
    fileExists: googleCredentialsFileExists(credentialsPath),
    bootstrapMs: Date.now() - startedAt,
    jsonParseSuccess: true,
  };

  nLog("[VERTEX_AUTH_SUCCESS]", result);
  return result;
}