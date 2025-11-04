import fs from "fs";
import path from "path";

export type RoomGroupId = string;
export type StagingProfileId = string;

export interface StagingProfile {
  id: StagingProfileId;
  roomGroupId: RoomGroupId;
  styleName: string;
  model: "staging-v1";
  seed: number;
  prompt: string;
  negativePrompt?: string;
  furniturePackId?: string;
  palette?: string[];
  createdAt: string;
  updatedAt: string;
}

function dataDir() {
  return process.env.DATA_DIR || path.resolve(process.cwd(), "..", "server", "data");
}

export function getStagingProfile(profileId: string): StagingProfile | undefined {
  try {
    const p = path.join(dataDir(), "stagingProfiles.json");
    if (!fs.existsSync(p)) return undefined;
    const json = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
    return json[profileId] as StagingProfile | undefined;
  } catch {
    return undefined;
  }
}
