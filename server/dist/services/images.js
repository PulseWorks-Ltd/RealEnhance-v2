"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createImageRecord = createImageRecord;
exports.addImageVersion = addImageVersion;
exports.getImageRecord = getImageRecord;
exports.listImagesForUser = listImagesForUser;
exports.undoLastEdit = undoLastEdit;
const node_crypto_1 = __importDefault(require("node:crypto"));
const jsonStore_1 = require("./jsonStore");
function loadAll() {
    return (0, jsonStore_1.readJsonFile)("images.json", {});
}
function saveAll(state) {
    (0, jsonStore_1.writeJsonFile)("images.json", state);
}
function createImageRecord(params) {
    const state = loadAll();
    const imageId = "img_" + node_crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    const record = {
        imageId,
        ownerUserId: params.userId,
        originalPath: params.originalPath,
        roomType: params.roomType,
        sceneType: params.sceneType,
        history: [],
        currentVersionId: "",
        createdAt: now,
        updatedAt: now
    };
    state[imageId] = record;
    saveAll(state);
    return record;
}
function addImageVersion(imageId, data) {
    const state = loadAll();
    const rec = state[imageId];
    if (!rec)
        throw new Error("Image not found");
    const versionId = "v_" + node_crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    const version = {
        versionId,
        stageLabel: data.stageLabel,
        filePath: data.filePath,
        createdAt: now,
        note: data.note
    };
    rec.history.push(version);
    rec.currentVersionId = versionId;
    rec.updatedAt = now;
    state[imageId] = rec;
    saveAll(state);
    return { versionId, record: rec };
}
function getImageRecord(imageId) {
    const state = loadAll();
    return state[imageId];
}
function listImagesForUser(userId) {
    const state = loadAll();
    return Object.values(state).filter(img => img.ownerUserId === userId);
}
// Optional: undo route can call this
function undoLastEdit(imageId) {
    const state = loadAll();
    const rec = state[imageId];
    if (!rec)
        return;
    if (rec.history.length <= 1) {
        // can't undo if there's only one version
        return rec;
    }
    rec.history.pop();
    const newLast = rec.history[rec.history.length - 1];
    rec.currentVersionId = newLast.versionId;
    rec.updatedAt = new Date().toISOString();
    state[imageId] = rec;
    saveAll(state);
    return rec;
}
