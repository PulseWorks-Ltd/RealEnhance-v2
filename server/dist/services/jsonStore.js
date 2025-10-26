"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const dataDir = node_path_1.default.join(process.cwd(), "server", "data");
// make sure it exists
if (!node_fs_1.default.existsSync(dataDir)) {
    node_fs_1.default.mkdirSync(dataDir, { recursive: true });
}
function readJsonFile(fileName, fallback) {
    const full = node_path_1.default.join(dataDir, fileName);
    if (!node_fs_1.default.existsSync(full))
        return fallback;
    try {
        return JSON.parse(node_fs_1.default.readFileSync(full, "utf8"));
    }
    catch (err) {
        console.error(`[jsonStore] Failed to read ${fileName}`, err);
        return fallback;
    }
}
function writeJsonFile(fileName, data) {
    const full = node_path_1.default.join(dataDir, fileName);
    node_fs_1.default.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
}
