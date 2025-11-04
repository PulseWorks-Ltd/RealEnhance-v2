import { Router } from "express";
import { createStagingProfile, getRoomGroup, getStagingProfile, listRoomGroups, upsertRoomGroup } from "../services/groups.js";

export function groupsRouter() {
  const r = Router();

  // Create or update a room group
  r.post("/room-groups", (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });
    try {
      const { id, batchId, roomType, label, imageIds, confirmedByUser, stagingProfileId } = req.body || {};
      const rec = upsertRoomGroup({ id, batchId, roomType, label, imageIds: imageIds || [], confirmedByUser: !!confirmedByUser, stagingProfileId });
      res.json({ ok: true, data: rec });
    } catch (e:any) {
      res.status(400).json({ ok: false, error: e?.message || "invalid" });
    }
  });

  r.get("/room-groups", (_req, res) => {
    res.json({ ok: true, data: listRoomGroups() });
  });

  // Create staging profile
  r.post("/staging-profiles", (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });
    try {
      const { roomGroupId, styleName, model, seed, prompt, negativePrompt, furniturePackId, palette } = req.body || {};
      const rec = createStagingProfile({ roomGroupId, styleName, model: model || "staging-v1", seed: Number(seed ?? 0), prompt: String(prompt || ""), negativePrompt, furniturePackId, palette });
      res.json({ ok: true, data: rec });
    } catch (e:any) {
      res.status(400).json({ ok: false, error: e?.message || "invalid" });
    }
  });

  r.get("/staging-profiles/:id", (req, res) => {
    const rec = getStagingProfile(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rec });
  });

  return r;
}
