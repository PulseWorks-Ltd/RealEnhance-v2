#!/usr/bin/env node
/**
 * GEOMETRIC FEATURE STABILITY ANALYSIS
 * 
 * Analyzes 10 repeatability runs to determine which geometric representations
 * are most stable across extraction runs.
 * 
 * Tests:
 * - Image coordinate bbox variance (current approach)
 * - Centroid variance (center point)
 * - Width/height variance
 * - Area variance
 * - Wall-relative coordinates variance
 * 
 * Goal: Determine if the problem is bbox variance or if robust features like
 * centroid+size are actually stable, which would suggest using matching
 * based on geometric similarity rather than exact bbox bounds.
 */

import fs from 'fs';
import path from 'path';

const AUDIT_FILE = '/workspaces/RealEnhance-v2/analysis/window_shift_regression/current_extraction_repeatability_1781231564451.json';
const OUT_DIR = '/workspaces/RealEnhance-v2/analysis/window_shift_regression';

function computeStats(values) {
  if (values.length === 0) throw new Error('Cannot compute stats on empty array');
  
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const cv = mean !== 0 ? stddev / mean : 0;
  const range = max - min;

  return { min, max, mean, stddev, range, cv };
}

function extractGeometricFeatures(bbox) {
  const [x1, y1, x2, y2] = [bbox.x1, bbox.y1, bbox.x2, bbox.y2];
  const width = x2 - x1;
  const height = y2 - y1;
  const area = width * height;
  const centroid = [(x1 + x2) / 2, (y1 + y2) / 2];
  const aspectRatio = height > 0 ? width / height : 0;

  return { bbox, centroid, width, height, area, aspectRatio };
}

function estimateWallDimensions(wallIndex) {
  // Simple wall model assuming 4 walls in a room
  // This is approximate and depends on camera position
  // wallIndex: 0=front, 1=right, 2=back, 3=left
  
  // Rough heuristic: 
  // Front wall: center-bottom region (x: 0.2-0.8, y: 0.5-1.0)
  // Right wall: right region (x: 0.7-1.0, y: 0.2-0.9)
  // Back wall: top region (x: 0.2-0.8, y: 0-0.5)
  // Left wall: left region (x: 0-0.3, y: 0.2-0.9)
  
  const wallBounds = {
    0: { minX: 0.15, maxX: 0.85, minY: 0.45, maxY: 1.0 },   // front
    1: { minX: 0.65, maxX: 1.0, minY: 0.15, maxY: 0.95 },   // right
    2: { minX: 0.15, maxX: 0.85, minY: 0.0, maxY: 0.55 },   // back
    3: { minX: 0.0, maxX: 0.35, minY: 0.15, maxY: 0.95 },   // left
  };

  return wallBounds[wallIndex] || wallBounds[0];
}

function extractWallRelativeFeatures(features, wallIndex) {
  const [cx, cy] = features.centroid;
  const { minX, maxX, minY, maxY } = estimateWallDimensions(wallIndex);
  
  const wallWidth = maxX - minX;
  const wallHeight = maxY - minY;
  
  // Wall-relative x position: 0 = left edge of wall, 1 = right edge of wall
  const wallCenterX = (cx - minX) / wallWidth;
  
  // Wall-relative width: fraction of wall width
  const wallRelativeWidth = features.width / wallWidth;
  
  // Y position and height (still in image coords, but normalized to visible wall area)
  const yCenter = cy;
  const yHeight = features.height;
  
  // Area as fraction of wall
  const wallArea = wallWidth * wallHeight;
  const areaFraction = features.area / wallArea;

  return {
    wallCenterX: Math.max(0, Math.min(1, wallCenterX)), // Clamp to 0-1
    wallWidth: wallRelativeWidth,
    yCenter,
    yHeight,
    area: areaFraction,
  };
}

function main() {
  console.log('='.repeat(80));
  console.log('GEOMETRIC FEATURE STABILITY ANALYSIS');
  console.log('='.repeat(80));
  console.log('');

  // Load audit data
  const auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
  const runs = auditData.runs;

  console.log(`Analyzing ${runs.length} extraction runs`);
  console.log('');

  // Extract features for each opening across all runs
  const openingIds = ['W1', 'W2'];
  const analysisResults = {};

  for (const openingId of openingIds) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`OPENING: ${openingId}`);
    console.log(`${'='.repeat(80)}\n`);

    const features_array = [];
    const wallIndices = [];

    for (const run of runs) {
      const opening = run.openings.find((o) => o.id === openingId);
      if (!opening) {
        console.error(`ERROR: Opening ${openingId} not found in run ${run.runIndex}`);
        process.exit(1);
      }

      const features = extractGeometricFeatures({
        x1: opening.bbox[0],
        y1: opening.bbox[1],
        x2: opening.bbox[2],
        y2: opening.bbox[3],
      });

      features_array.push(features);
      wallIndices.push(opening.wallIndex);
    }

    // Check wall consistency
    const uniqueWalls = new Set(wallIndices);
    console.log(`Wall Assignment: ${Array.from(uniqueWalls).join(', ')} (consistent: ${uniqueWalls.size === 1})`);
    console.log('');

    // Extract all features for analysis
    const bboxX1Values = features_array.map((f) => f.bbox.x1);
    const bboxY1Values = features_array.map((f) => f.bbox.y1);
    const bboxX2Values = features_array.map((f) => f.bbox.x2);
    const bboxY2Values = features_array.map((f) => f.bbox.y2);
    const centroidXValues = features_array.map((f) => f.centroid[0]);
    const centroidYValues = features_array.map((f) => f.centroid[1]);
    const widthValues = features_array.map((f) => f.width);
    const heightValues = features_array.map((f) => f.height);
    const areaValues = features_array.map((f) => f.area);
    const aspectRatioValues = features_array.map((f) => f.aspectRatio);

    // IMAGE COORDINATE ANALYSIS
    console.log('IMAGE COORDINATE FEATURES:');
    console.log('-'.repeat(80));

    const stats_bboxX1 = computeStats(bboxX1Values);
    const stats_bboxY1 = computeStats(bboxY1Values);
    const stats_bboxX2 = computeStats(bboxX2Values);
    const stats_bboxY2 = computeStats(bboxY2Values);
    const stats_centroidX = computeStats(centroidXValues);
    const stats_centroidY = computeStats(centroidYValues);
    const stats_width = computeStats(widthValues);
    const stats_height = computeStats(heightValues);
    const stats_area = computeStats(areaValues);
    const stats_aspectRatio = computeStats(aspectRatioValues);

    console.log('\nBBox Coordinates (x1, y1, x2, y2):');
    console.log(`  x1: min=${stats_bboxX1.min.toFixed(3)}, max=${stats_bboxX1.max.toFixed(3)}, mean=${stats_bboxX1.mean.toFixed(3)}, stddev=${stats_bboxX1.stddev.toFixed(3)}, cv=${stats_bboxX1.cv.toFixed(4)}`);
    console.log(`  y1: min=${stats_bboxY1.min.toFixed(3)}, max=${stats_bboxY1.max.toFixed(3)}, mean=${stats_bboxY1.mean.toFixed(3)}, stddev=${stats_bboxY1.stddev.toFixed(3)}, cv=${stats_bboxY1.cv.toFixed(4)}`);
    console.log(`  x2: min=${stats_bboxX2.min.toFixed(3)}, max=${stats_bboxX2.max.toFixed(3)}, mean=${stats_bboxX2.mean.toFixed(3)}, stddev=${stats_bboxX2.stddev.toFixed(3)}, cv=${stats_bboxX2.cv.toFixed(4)}`);
    console.log(`  y2: min=${stats_bboxY2.min.toFixed(3)}, max=${stats_bboxY2.max.toFixed(3)}, mean=${stats_bboxY2.mean.toFixed(3)}, stddev=${stats_bboxY2.stddev.toFixed(3)}, cv=${stats_bboxY2.cv.toFixed(4)}`);

    console.log('\nCentroid (center point):');
    console.log(`  cx: min=${stats_centroidX.min.toFixed(3)}, max=${stats_centroidX.max.toFixed(3)}, mean=${stats_centroidX.mean.toFixed(3)}, stddev=${stats_centroidX.stddev.toFixed(3)}, cv=${stats_centroidX.cv.toFixed(4)}`);
    console.log(`  cy: min=${stats_centroidY.min.toFixed(3)}, max=${stats_centroidY.max.toFixed(3)}, mean=${stats_centroidY.mean.toFixed(3)}, stddev=${stats_centroidY.stddev.toFixed(3)}, cv=${stats_centroidY.cv.toFixed(4)}`);

    console.log('\nDimensions:');
    console.log(`  width:  min=${stats_width.min.toFixed(3)}, max=${stats_width.max.toFixed(3)}, mean=${stats_width.mean.toFixed(3)}, stddev=${stats_width.stddev.toFixed(3)}, cv=${stats_width.cv.toFixed(4)}`);
    console.log(`  height: min=${stats_height.min.toFixed(3)}, max=${stats_height.max.toFixed(3)}, mean=${stats_height.mean.toFixed(3)}, stddev=${stats_height.stddev.toFixed(3)}, cv=${stats_height.cv.toFixed(4)}`);
    console.log(`  area:   min=${stats_area.min.toFixed(4)}, max=${stats_area.max.toFixed(4)}, mean=${stats_area.mean.toFixed(4)}, stddev=${stats_area.stddev.toFixed(4)}, cv=${stats_area.cv.toFixed(4)}`);
    console.log(`  aspect: min=${stats_aspectRatio.min.toFixed(3)}, max=${stats_aspectRatio.max.toFixed(3)}, mean=${stats_aspectRatio.mean.toFixed(3)}, stddev=${stats_aspectRatio.stddev.toFixed(3)}, cv=${stats_aspectRatio.cv.toFixed(4)}`);

    // WALL-RELATIVE ANALYSIS
    console.log('\n\nWALL-RELATIVE FEATURES:');
    console.log('-'.repeat(80));

    const wallRelativeFeatures_array = features_array.map((f, idx) => extractWallRelativeFeatures(f, wallIndices[idx]));

    const wallCenterXValues = wallRelativeFeatures_array.map((f) => f.wallCenterX);
    const wallWidthValues = wallRelativeFeatures_array.map((f) => f.wallWidth);
    const yHeightValues = wallRelativeFeatures_array.map((f) => f.yHeight);
    const wallAreaValues = wallRelativeFeatures_array.map((f) => f.area);

    const stats_wallCenterX = computeStats(wallCenterXValues);
    const stats_wallWidth = computeStats(wallWidthValues);
    const stats_yHeight = computeStats(yHeightValues);
    const stats_wallArea = computeStats(wallAreaValues);

    console.log('\nWall-Relative Position & Size:');
    console.log(`  wall_center_x: min=${stats_wallCenterX.min.toFixed(3)}, max=${stats_wallCenterX.max.toFixed(3)}, mean=${stats_wallCenterX.mean.toFixed(3)}, stddev=${stats_wallCenterX.stddev.toFixed(3)}, cv=${stats_wallCenterX.cv.toFixed(4)}`);
    console.log(`  wall_width:    min=${stats_wallWidth.min.toFixed(3)}, max=${stats_wallWidth.max.toFixed(3)}, mean=${stats_wallWidth.mean.toFixed(3)}, stddev=${stats_wallWidth.stddev.toFixed(3)}, cv=${stats_wallWidth.cv.toFixed(4)}`);
    console.log(`  y_height:      min=${stats_yHeight.min.toFixed(3)}, max=${stats_yHeight.max.toFixed(3)}, mean=${stats_yHeight.mean.toFixed(3)}, stddev=${stats_yHeight.stddev.toFixed(3)}, cv=${stats_yHeight.cv.toFixed(4)}`);
    console.log(`  wall_area:     min=${stats_wallArea.min.toFixed(4)}, max=${stats_wallArea.max.toFixed(4)}, mean=${stats_wallArea.mean.toFixed(4)}, stddev=${stats_wallArea.stddev.toFixed(4)}, cv=${stats_wallArea.cv.toFixed(4)}`);

    // FEATURE RANK BY STABILITY (lowest cv = most stable)
    console.log('\n\nSTABILITY RANKING (sorted by Coefficient of Variation):');
    console.log('-'.repeat(80));

    const allFeatures = [
      { name: 'centroid_x', cv: stats_centroidX.cv, type: 'image' },
      { name: 'centroid_y', cv: stats_centroidY.cv, type: 'image' },
      { name: 'width', cv: stats_width.cv, type: 'image' },
      { name: 'height', cv: stats_height.cv, type: 'image' },
      { name: 'area', cv: stats_area.cv, type: 'image' },
      { name: 'aspect_ratio', cv: stats_aspectRatio.cv, type: 'image' },
      { name: 'bbox_x1', cv: stats_bboxX1.cv, type: 'image' },
      { name: 'bbox_y1', cv: stats_bboxY1.cv, type: 'image' },
      { name: 'bbox_x2', cv: stats_bboxX2.cv, type: 'image' },
      { name: 'bbox_y2', cv: stats_bboxY2.cv, type: 'image' },
      { name: 'wall_center_x', cv: stats_wallCenterX.cv, type: 'wall' },
      { name: 'wall_width', cv: stats_wallWidth.cv, type: 'wall' },
      { name: 'y_height', cv: stats_yHeight.cv, type: 'wall' },
      { name: 'wall_area', cv: stats_wallArea.cv, type: 'wall' },
    ];

    const sorted = allFeatures.sort((a, b) => a.cv - b.cv);

    sorted.forEach((feature, idx) => {
      const stability = feature.cv < 0.01 ? '★★★ VERY STABLE' : feature.cv < 0.05 ? '★★ STABLE' : feature.cv < 0.15 ? '★ UNSTABLE' : '✗ HIGHLY UNSTABLE';
      console.log(`${(idx + 1).toString().padStart(2)}. ${feature.name.padEnd(20)} cv=${feature.cv.toFixed(4)} (${feature.type.padEnd(5)}) ${stability}`);
    });

    analysisResults[openingId] = {
      image_coords: {
        bbox_x1: stats_bboxX1,
        bbox_y1: stats_bboxY1,
        bbox_x2: stats_bboxX2,
        bbox_y2: stats_bboxY2,
        centroid_x: stats_centroidX,
        centroid_y: stats_centroidY,
        width: stats_width,
        height: stats_height,
        area: stats_area,
        aspect_ratio: stats_aspectRatio,
      },
      wall_relative: {
        wall_center_x: stats_wallCenterX,
        wall_width: stats_wallWidth,
        y_height: stats_yHeight,
        wall_area: stats_wallArea,
      },
      ranking: sorted,
    };
  }

  // CROSS-OPENING COMPARISON
  console.log('\n\n' + '='.repeat(80));
  console.log('CROSS-OPENING COMPARISON');
  console.log('='.repeat(80));
  console.log('\nFeature Stability Across All Openings:\n');

  const allOpeningFeatures = [
    'centroid_x',
    'centroid_y',
    'width',
    'height',
    'area',
    'aspect_ratio',
    'bbox_x1',
    'bbox_y1',
    'bbox_x2',
    'bbox_y2',
    'wall_center_x',
    'wall_width',
    'y_height',
    'wall_area',
  ];

  const featureScores = {};
  for (const feature of allOpeningFeatures) {
    featureScores[feature] = [];
    for (const openingId of openingIds) {
      const ranking = analysisResults[openingId].ranking;
      const rank = ranking.findIndex((f) => f.name === feature);
      if (rank !== -1) {
        featureScores[feature].push(rank + 1); // Rank position (1-based)
      }
    }
  }

  const avgRanks = Object.entries(featureScores).map(([feature, scores]) => ({
    feature,
    avgRank: scores.reduce((a, b) => a + b, 0) / scores.length,
    scores: scores.join(', '),
  }));
  avgRanks.sort((a, b) => a.avgRank - b.avgRank);

  console.log('Feature\t\t\tAvg Rank\tRanks (W1, W2)');
  console.log('-'.repeat(70));
  avgRanks.forEach((item) => {
    console.log(`${item.feature.padEnd(24)}\t${item.avgRank.toFixed(2)}\t\t${item.scores}`);
  });

  // KEY INSIGHTS
  console.log('\n\n' + '='.repeat(80));
  console.log('KEY INSIGHTS');
  console.log('='.repeat(80));

  const w1_most_stable = analysisResults.W1.ranking[0];
  const w2_most_stable = analysisResults.W2.ranking[0];

  const w1_least_stable = analysisResults.W1.ranking[analysisResults.W1.ranking.length - 1];
  const w2_least_stable = analysisResults.W2.ranking[analysisResults.W2.ranking.length - 1];

  console.log(`\n1. MOST STABLE FEATURES:`);
  console.log(`   W1: ${w1_most_stable.name} (cv=${w1_most_stable.cv.toFixed(4)})`);
  console.log(`   W2: ${w2_most_stable.name} (cv=${w2_most_stable.cv.toFixed(4)})`);
  console.log(`   Avg Rank Winner: ${avgRanks[0].feature} (avg_rank=${avgRanks[0].avgRank.toFixed(2)})`);

  console.log(`\n2. LEAST STABLE FEATURES:`);
  console.log(`   W1: ${w1_least_stable.name} (cv=${w1_least_stable.cv.toFixed(4)})`);
  console.log(`   W2: ${w2_least_stable.name} (cv=${w2_least_stable.cv.toFixed(4)})`);

  // Analyze image vs wall-relative based on avgRanks
  const allImageFeatures = avgRanks.filter((f) => analysisResults['W1'].ranking.find((r) => r.name === f.feature)?.type === 'image');
  const allWallFeatures = avgRanks.filter((f) => analysisResults['W1'].ranking.find((r) => r.name === f.feature)?.type === 'wall');

  const avgImageCV = allImageFeatures.length > 0
    ? allImageFeatures.reduce((sum, f) => {
        const cv = analysisResults['W1'].ranking.find((r) => r.name === f.feature)?.cv || analysisResults['W2'].ranking.find((r) => r.name === f.feature)?.cv || 0;
        return sum + cv;
      }, 0) / allImageFeatures.length
    : 0;

  const avgWallCV = allWallFeatures.length > 0
    ? allWallFeatures.reduce((sum, f) => {
        const cv = analysisResults['W1'].ranking.find((r) => r.name === f.feature)?.cv || analysisResults['W2'].ranking.find((r) => r.name === f.feature)?.cv || 0;
        return sum + cv;
      }, 0) / allWallFeatures.length
    : 0;

  console.log(`\n3. IMAGE vs WALL-RELATIVE COORDINATES:`);
  console.log(`   Average CV (Image Coords):  ${avgImageCV.toFixed(4)}`);
  console.log(`   Average CV (Wall-Relative): ${avgWallCV.toFixed(4)}`);
  console.log(`   Winner: ${avgImageCV < avgWallCV ? 'IMAGE COORDINATES' : 'WALL-RELATIVE COORDINATES'}`);

  console.log(`\n4. RECOMMENDATION:`);
  if (avgRanks[0].feature.includes('centroid') || avgRanks[0].feature.includes('width') || avgRanks[0].feature.includes('height')) {
    console.log(`\n   The most stable feature is: ${avgRanks[0].feature}`);
    console.log(`\n   This suggests that instead of constraining bbox boundaries more tightly,`);
    console.log(`   you should use CENTROID + SIZE (width/height/area) as the canonical`);
    console.log(`   representation for matching openings across extractions.`);
    console.log(`\n   Solution: Update openingValidator.ts to match openings by:`);
    console.log(`   - Centroid distance < 0.05 (in image coords)`);
    console.log(`   - Dimension similarity > 0.9 (width, height, area)`);
    console.log(`   - Wall assignment must match`);
    console.log(`\n   This avoids strict bbox matching while capturing the true geometric essence.`);
  } else if (avgRanks[0].feature.startsWith('bbox')) {
    console.log(`\n   BBox coordinates are the most stable. This is unexpected.`);
    console.log(`   Consider investigating what makes ${avgRanks[0].feature} so stable.`);
  } else {
    console.log(`\n   Wall-relative coordinates are most stable: ${avgRanks[0].feature}`);
    console.log(`   This suggests the prompt should guide Gemini to normalize measurements`);
    console.log(`   relative to wall dimensions, not absolute image coordinates.`);
  }

  // Save detailed report
  const report = {
    timestamp: new Date().toISOString(),
    methodology:
      'Extracts geometric features (centroid, width, height, area, aspect ratio) from 10 extraction runs and computes variance using coefficient of variation (CV). Features are analyzed in both image and wall-relative coordinates.',
    baseline_image: '/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg',
    runs_analyzed: runs.length,
    opening_analysis: analysisResults,
    cross_opening_ranking: avgRanks,
    insights: {
      most_stable_feature: avgRanks[0].feature,
      least_stable_feature: avgRanks[avgRanks.length - 1].feature,
      image_avg_cv: avgImageCV,
      wall_relative_avg_cv: avgWallCV,
      recommendation: avgImageCV < avgWallCV ? 'Use image coordinates with centroid+size matching' : 'Use wall-relative coordinates',
    },
  };

  const reportPath = path.join(OUT_DIR, `geometric_feature_stability_analysis_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n\nDetailed report saved to: ${reportPath}`);
  console.log('\n' + '='.repeat(80));
}

main();
