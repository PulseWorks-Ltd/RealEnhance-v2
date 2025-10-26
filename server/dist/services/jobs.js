"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueEnhanceJob = enqueueEnhanceJob;
exports.enqueueEditJob = enqueueEditJob;
exports.getJob = getJob;
const node_crypto_1 = __importDefault(require("node:crypto"));
const bullmq_1 = require("bullmq");
const constants_1 = require("@realenhance/shared/dist/constants");
const config_1 = require("../config");
const jsonStore_1 = require("./jsonStore");
function loadAll() {
    return (0, jsonStore_1.readJsonFile)("jobs.json", {});
}
function saveAll(state) {
    (0, jsonStore_1.writeJsonFile)("jobs.json", state);
}
function queue() {
    return new bullmq_1.Queue(constants_1.JOB_QUEUE_NAME, {
        connection: { url: config_1.REDIS_URL }
    });
}
// enhance job
async function enqueueEnhanceJob(params) {
    const jobId = "job_" + node_crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    const payload = {
        jobId,
        userId: params.userId,
        imageId: params.imageId,
        type: "enhance",
        options: params.options,
        createdAt: now
    };
    const state = loadAll();
    state[jobId] = {
        jobId,
        userId: params.userId,
        imageId: params.imageId,
        type: "enhance",
        status: "queued",
        createdAt: now,
        updatedAt: now
    };
    saveAll(state);
    await queue().add(constants_1.JOB_QUEUE_NAME, payload, { jobId });
    return { jobId };
}
// edit job
async function enqueueEditJob(params) {
    const jobId = "job_" + node_crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    const payload = {
        jobId,
        userId: params.userId,
        imageId: params.imageId,
        type: "edit",
        baseVersionId: params.baseVersionId,
        mode: params.mode,
        instruction: params.instruction,
        mask: params.mask,
        createdAt: now
    };
    const state = loadAll();
    state[jobId] = {
        jobId,
        userId: params.userId,
        imageId: params.imageId,
        type: "edit",
        status: "queued",
        createdAt: now,
        updatedAt: now
    };
    saveAll(state);
    await queue().add(constants_1.JOB_QUEUE_NAME, payload, { jobId });
    return { jobId };
}
function getJob(jobId) {
    const state = loadAll();
    return state[jobId];
}
