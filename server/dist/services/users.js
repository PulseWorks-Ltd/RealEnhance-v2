"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertUserFromGoogle = upsertUserFromGoogle;
exports.getUserById = getUserById;
exports.addImageToUser = addImageToUser;
exports.getUserGallery = getUserGallery;
exports.getCredits = getCredits;
exports.consumeCredits = consumeCredits;
exports.chargeForImages = chargeForImages;
const node_crypto_1 = __importDefault(require("node:crypto"));
const constants_1 = require("@realenhance/shared/dist/constants");
const config_1 = require("../config");
const jsonStore_1 = require("./jsonStore");
function loadAll() {
    return (0, jsonStore_1.readJsonFile)("users.json", {});
}
function saveAll(state) {
    (0, jsonStore_1.writeJsonFile)("users.json", state);
}
function upsertUserFromGoogle(params) {
    const state = loadAll();
    let found = Object.values(state).find(u => u.email === params.email);
    if (!found) {
        const id = "user_" + node_crypto_1.default.randomUUID();
        const now = new Date().toISOString();
        found = {
            id,
            email: params.email,
            name: params.name,
            credits: 50,
            imageIds: [],
            createdAt: now,
            updatedAt: now
        };
        state[id] = found;
    }
    else {
        found.name = params.name || found.name;
        found.updatedAt = new Date().toISOString();
    }
    saveAll(state);
    return found;
}
function getUserById(userId) {
    const state = loadAll();
    return state[userId];
}
function addImageToUser(userId, imageId) {
    const state = loadAll();
    const u = state[userId];
    if (!u)
        return;
    if (!u.imageIds.includes(imageId)) {
        u.imageIds.push(imageId);
        u.updatedAt = new Date().toISOString();
        saveAll(state);
    }
}
function getUserGallery(userId) {
    const u = getUserById(userId);
    return u?.imageIds ?? [];
}
function getCredits(userId) {
    const u = getUserById(userId);
    return u?.credits ?? 0;
}
function consumeCredits(userId, count) {
    if (!config_1.CREDITS_ENABLED)
        return;
    const state = loadAll();
    const u = state[userId];
    if (!u)
        return;
    u.credits = Math.max(0, u.credits - count);
    u.updatedAt = new Date().toISOString();
    saveAll(state);
}
function chargeForImages(userId, numImages) {
    if (!config_1.CREDITS_ENABLED)
        return;
    consumeCredits(userId, numImages * constants_1.CREDITS_PER_IMAGE);
}
