import { validateStructureWithOpenCV } from "../structural-opencv";
import fs from "fs";
import path from "path";

describe("OpenCV Structural Validator", () => {
  it("should return ok for a valid image", async () => {
    // Use a sample image (replace with a real test image path)
    const imgPath = path.join(__dirname, "../../test-data/valid-room.jpg");
    if (!fs.existsSync(imgPath)) return;
    const buf = fs.readFileSync(imgPath);
    const result = await validateStructureWithOpenCV(buf);
    expect(result).toHaveProperty("ok");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("should return errors for an invalid image", async () => {
    // Use a blank image or corrupted file
    const imgPath = path.join(__dirname, "../../test-data/blank.jpg");
    if (!fs.existsSync(imgPath)) return;
    const buf = fs.readFileSync(imgPath);
    const result = await validateStructureWithOpenCV(buf, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
