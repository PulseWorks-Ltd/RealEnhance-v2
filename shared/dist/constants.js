"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTINUITY_RENDER_QUEUE = exports.JOB_QUEUE_NAME = exports.CREDITS_PER_IMAGE = void 0;
exports.CREDITS_PER_IMAGE = 1;
// Unified BullMQ queue name across server and worker. Must match server/src/shared/constants.ts
exports.JOB_QUEUE_NAME = "image-jobs";
exports.CONTINUITY_RENDER_QUEUE = "continuity-experimental";
