// server/src/services/stagedLabel.ts
// Adds a small "Virtually Staged" label to the bottom-left corner of a staged
// image at download time. The stored image is never changed, so retries and
// edits keep working from the clean version.
//
// The text is drawn from pre-made vector outlines (Inter SemiBold, SIL Open
// Font License) instead of a font, so it renders the same on any server even
// when no fonts are installed.

import sharp from "sharp";

const LABEL_PATH = "M25.9 76.2L42.4 76.2L67.9 3.5L53.7 3.5L41.2 41.3C39.1 47.8 36.9 55.7 34.3 65.8C31.6 55.8 29.2 47.7 27.2 41.3L14.3 3.5L0 3.5ZM77.1 76.2L89.7 76.2L89.7 21.6L77.1 21.6ZM83.4 13.9C87.5 13.9 90.8 10.8 90.8 6.9C90.8 3.1 87.5 0 83.4 0C79.3 0 76.0 3.1 76.0 6.9C76.0 10.8 79.3 13.9 83.4 13.9ZM103.2 76.2L115.9 76.2L115.9 44.1C115.9 37.2 121.1 32.3 128.2 32.3C130.5 32.3 133.2 32.6 134.2 32.9L134.2 21.2C133.0 21.0 131.0 20.9 129.6 20.9C123.3 20.9 118.1 24.5 116.1 30.8L115.5 30.8L115.5 21.6L103.2 21.6ZM168.2 21.6L157.6 21.6L157.6 8.6L144.9 8.6L144.9 21.6L137.2 21.6L137.2 31.6L144.9 31.6L144.9 61.9C144.9 71.6 150.7 77.0 161.2 77.0C163.9 77.0 166.9 76.6 169.7 75.8L167.7 66.0C166.5 66.3 164.2 66.6 163.0 66.6C159.2 66.6 157.6 64.8 157.6 60.8L157.6 31.6L168.2 31.6ZM196.9 76.9C204.8 76.9 210.5 73.1 213.8 65.3L213.9 76.2L226.0 76.2L226.0 21.6L213.2 21.6L213.2 53.6C213.2 61.5 208.3 66.1 201.6 66.1C195.0 66.1 190.9 61.7 190.9 54.4L190.9 21.6L178.2 21.6L178.2 56.3C178.2 69.5 185.7 76.9 196.9 76.9ZM254.7 77.3C263.2 77.3 268.4 73.4 270.8 68.7L271.2 68.7L271.2 76.2L283.4 76.2L283.4 39.7C283.4 25.2 271.4 20.9 261.1 20.9C250.2 20.9 241.2 25.6 238.0 35.2L249.8 37.6C251.1 34.0 254.8 30.7 261.2 30.7C267.4 30.7 270.7 33.8 270.7 39.2L270.7 39.4C270.7 43.2 266.7 43.3 257.2 44.3C246.7 45.5 236.4 48.6 236.4 60.9C236.4 71.6 244.3 77.3 254.7 77.3ZM258.0 67.9C252.6 67.9 248.7 65.5 248.7 60.7C248.7 55.8 253.0 53.7 258.7 52.9C262.0 52.4 269.1 51.6 270.8 50.2L270.8 56.6C270.8 62.7 265.8 67.9 258.0 67.9ZM309.6 3.5L296.9 3.5L296.9 76.2L309.6 76.2ZM335.7 3.5L323.0 3.5L323.0 76.2L335.7 76.2ZM348.7 95.7C350.4 96.4 353.6 97.0 357.2 97.0C367.0 97.0 372.7 92.0 376.0 83.3L399.4 21.6L386.0 21.6L375.7 51.3C374.1 56.0 372.9 60.7 371.6 65.5C370.6 60.7 369.5 56.1 367.9 51.3L358.0 21.6L344.4 21.6L365.0 76.4L364.2 79.9C362.9 86.1 358.9 87.7 353.2 86.2L351.7 85.8ZM459.4 77.3C476.8 77.3 486.9 68.6 486.9 55.8C486.9 43.1 476.3 37.5 465.5 34.9L458.7 33.2C452.8 31.7 446.3 29.2 446.3 23.1C446.3 17.6 451.3 13.6 459.5 13.6C467.4 13.6 472.7 17.2 473.3 23.4L485.9 23.4C485.6 11.2 475.2 2.5 459.7 2.5C444.5 2.5 433.2 11.1 433.2 23.9C433.2 34.2 440.3 40.3 452.5 43.5L460.7 45.6C468.6 47.7 473.9 50.0 473.9 55.7C473.9 62.0 467.9 66.2 459.3 66.2C451.1 66.2 444.6 62.5 444.0 54.8L431.2 54.8C431.7 69.2 442.4 77.3 459.4 77.3ZM523.5 21.6L513.0 21.6L513.0 8.6L500.3 8.6L500.3 21.6L492.5 21.6L492.5 31.6L500.3 31.6L500.3 61.9C500.3 71.6 506.1 77.0 516.6 77.0C519.2 77.0 522.3 76.6 525.0 75.8L523.0 66.0C521.8 66.3 519.6 66.6 518.4 66.6C514.6 66.6 513.0 64.8 513.0 60.8L513.0 31.6L523.5 31.6ZM548.8 77.3C557.3 77.3 562.5 73.4 564.9 68.7L565.4 68.7L565.4 76.2L577.5 76.2L577.5 39.7C577.5 25.2 565.5 20.9 555.3 20.9C544.3 20.9 535.4 25.6 532.1 35.2L543.9 37.6C545.2 34.0 549.0 30.7 555.3 30.7C561.5 30.7 564.8 33.8 564.8 39.2L564.8 39.4C564.8 43.2 560.8 43.3 551.4 44.3C540.8 45.5 530.6 48.6 530.6 60.9C530.6 71.6 538.4 77.3 548.8 77.3ZM552.1 67.9C546.7 67.9 542.9 65.5 542.9 60.7C542.9 55.8 547.2 53.7 552.9 52.9C556.2 52.4 563.2 51.6 564.9 50.2L564.9 56.6C564.9 62.7 559.9 67.9 552.1 67.9ZM614.6 97.8C629.2 97.8 640.1 91.0 640.1 76.4L640.1 21.6L627.6 21.6L627.6 30.7L627.0 30.7C625 26.8 620.8 20.9 611.2 20.9C598.6 20.9 588.6 30.9 588.6 48.8C588.6 66.6 598.5 75.4 611.1 75.4C620.5 75.4 624.5 70.4 626.5 66.5L627.5 66.5L627.5 76.8C627.5 84.6 622.4 88.1 614.5 88.1C606.5 88.1 603.2 84.4 601.5 81.3L590.7 85.2C593.5 92.4 601.4 97.8 614.6 97.8ZM614.6 65.4C606.2 65.4 601.6 58.7 601.6 48.7C601.6 38.8 606.1 31.4 614.6 31.4C623.0 31.4 627.6 38.3 627.6 48.7C627.6 59.1 622.9 65.4 614.6 65.4ZM677.7 77.3C689.8 77.3 698.3 71.5 701.0 62.7L689.3 60.3C687.6 64.9 683.4 67.4 677.8 67.4C669.7 67.4 664.2 62.2 663.8 52.5L701.8 52.5L701.8 48.5C701.8 29.3 690.2 20.9 676.9 20.9C661.2 20.9 651.2 32.5 651.2 49.3C651.2 66.4 661.2 77.3 677.7 77.3ZM663.9 43.8C664.5 36.6 669.1 30.9 676.9 30.9C684.5 30.9 688.7 36.0 689.5 43.8ZM732.8 77.2C742.2 77.2 746.4 71.5 748.4 67.6L749.2 67.6L749.2 76.2L761.7 76.2L761.7 3.5L749.0 3.5L749.0 30.7L748.4 30.7C746.5 26.8 742.5 20.9 732.8 20.9C720.2 20.9 710.3 30.9 710.3 49.0C710.3 66.9 719.9 77.2 732.8 77.2ZM736.3 66.7C727.8 66.7 723.3 59.2 723.3 49.0C723.3 38.8 727.7 31.4 736.3 31.4C744.6 31.4 749.2 38.3 749.2 49.0C749.2 59.6 744.5 66.7 736.3 66.7Z";
const LABEL_W = 761.7; // outline width at size 100
const LABEL_BASELINE = 76.2; // baseline offset from the top of the outline box
const LABEL_CAP = 72.8; // cap height at size 100

export const STAGED_LABEL_TEXT = "Virtually Staged";

function buildLabelSvg(imageW: number, imageH: number): { svg: Buffer; left: number; top: number } {
  const short = Math.min(imageW, imageH);
  const pillH = Math.max(26, Math.round(short * 0.045));
  const scale = (pillH * 0.4) / LABEL_CAP; // cap height = 40% of pill height
  const textW = LABEL_W * scale;
  const padX = Math.round(pillH * 0.45);
  const pillW = Math.round(textW + padX * 2);
  const margin = Math.max(10, Math.round(short * 0.025));
  // Centre the capital letters vertically in the pill.
  const textTop = pillH / 2 - (LABEL_BASELINE - LABEL_CAP / 2) * scale;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}">` +
    `<rect width="${pillW}" height="${pillH}" rx="${Math.round(pillH * 0.22)}" fill="#000" fill-opacity="0.55"/>` +
    `<path transform="translate(${padX} ${textTop.toFixed(2)}) scale(${scale.toFixed(5)})" fill="#fff" d="${LABEL_PATH}"/>` +
    `</svg>`;
  return { svg: Buffer.from(svg), left: margin, top: imageH - margin - pillH };
}

/** Returns the image with the label added, in the same format it came in. */
export async function addStagedLabel(buffer: Buffer, contentType: string): Promise<{ buffer: Buffer; contentType: string }> {
  const { data, info } = await sharp(buffer, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  if (info.width < 120 || info.height < 80) return { buffer, contentType };

  const { svg, left, top } = buildLabelSvg(info.width, info.height);
  const labelled = sharp(data).composite([{ input: svg, left, top }]);
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return { buffer: await labelled.png().toBuffer(), contentType: "image/png" };
  if (type.includes("webp")) return { buffer: await labelled.webp({ quality: 92 }).toBuffer(), contentType: "image/webp" };
  return { buffer: await labelled.jpeg({ quality: 92, mozjpeg: true }).toBuffer(), contentType: "image/jpeg" };
}
