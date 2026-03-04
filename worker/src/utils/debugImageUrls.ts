import fs from "fs/promises";
import path from "path";

type StageLabel = "1A" | "1B" | "2";

type DebugSignedUrlResult = {
  signedUrl: string | null;
  key: string | null;
};

function sanitizeRegion(input?: string | null): string {
  const raw = (input || "").trim();
  if (!raw) return "us-east-1";
  const match = raw.match(/([a-z]{2}-[a-z0-9-]+-\d)/i);
  return (match?.[1] || raw).toLowerCase();
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

export function isDebugImageUrlLoggingEnabled(): boolean {
  return process.env.ENABLE_DEBUG_IMAGE_URLS === "1" || process.env.SIGN_ALL_STAGE_OUTPUTS === "1";
}

export async function createDebugSignedUrl(localPath: string, jobId: string): Promise<DebugSignedUrlResult> {
  if (!isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return { signedUrl: null, key: null };
  }

  const region = sanitizeRegion(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1");
  const importer: any = new Function("p", "return import(p)");
  const s3Mod: any = await importer("@aws-sdk/client-s3");
  const presignMod: any = await importer("@aws-sdk/s3-request-presigner");
  const { S3Client, PutObjectCommand, GetObjectCommand } = s3Mod;
  const { getSignedUrl } = presignMod;

  const clientConfig: any = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }

  const body = await fs.readFile(localPath);
  const fileName = path.basename(localPath);
  const key = `debug-attempts/${jobId}/${fileName}`;
  const contentType = mimeFromExt(localPath);

  const s3 = new S3Client(clientConfig);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 }
  );

  return { signedUrl, key };
}

export async function logImageAttemptUrl(params: {
  stage: StageLabel;
  attempt: number;
  jobId: string;
  localPath: string;
}): Promise<DebugSignedUrlResult> {
  if (!isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }

  const fileName = path.basename(params.localPath);
  try {
    const signed = await createDebugSignedUrl(params.localPath, params.jobId);
    console.log(
      `[IMAGE_ATTEMPT_URL] stage=${params.stage} attempt=${params.attempt} job_id=${params.jobId} file=${fileName} signed_url=${signed.signedUrl || ""}`
    );
    return signed;
  } catch (error: any) {
    const reason = error?.message || String(error);
    console.warn(
      `[IMAGE_ATTEMPT_URL] stage=${params.stage} attempt=${params.attempt} job_id=${params.jobId} file=${fileName} signed_url=ERROR:${reason}`
    );
    return { signedUrl: null, key: null };
  }
}

export async function logBaselineImageUrl(params: {
  stage: "2";
  jobId: string;
  localPath: string;
}): Promise<DebugSignedUrlResult> {
  if (!isDebugImageUrlLoggingEnabled()) {
    return { signedUrl: null, key: null };
  }

  const fileName = path.basename(params.localPath);
  try {
    const signed = await createDebugSignedUrl(params.localPath, params.jobId);
    console.log(
      `[BASELINE_IMAGE_URL] stage=${params.stage} job_id=${params.jobId} file=${fileName} signed_url=${signed.signedUrl || ""}`
    );
    return signed;
  } catch (error: any) {
    const reason = error?.message || String(error);
    console.warn(
      `[BASELINE_IMAGE_URL] stage=${params.stage} job_id=${params.jobId} file=${fileName} signed_url=ERROR:${reason}`
    );
    return { signedUrl: null, key: null };
  }
}
