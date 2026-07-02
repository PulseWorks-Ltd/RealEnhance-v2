# Baseline Determinism Phase 3 - Observation-First Canonical Graph

Generated: 2026-07-01T01:12:23.589Z

- Total images: 6
- Inventory-stable images: 1
- Observation-stable images: 0
- Canonical-graph-stable images: 0
- Identity-stable images: 3
- Confidence-stable images: 4
- Opening-stable images: 2
- Inventory drift images: 5
- Observation drift images: 6
- Graph-builder drift images: 0
- Identity drift images: 3
- Confidence drift images: 2

## job_c11a8e7c
- Inventory stability: STABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: STABLE
- Opening stability: UNSTABLE
- Stability attribution: observation_drift

### Inventory
- Run 1 openings: window
- Run 1 fixtures: none
- Run 1 architectural features: none
- Run 2 openings: window
- Run 2 fixtures: none
- Run 2 architectural features: none

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 unused inventory: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 unused inventory: none
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 chosen anchors: wall_1:window, wall_2:wall_plane
- Run 1 rejected anchors: none
- Run 2 chosen anchors: wall_1:window, wall_2:wall_plane
- Run 2 rejected anchors: none
- Run 1 baseline confidence: 1
- Run 2 baseline confidence: 1

## job_bb029607
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: UNSTABLE
- Confidence stability: STABLE
- Opening stability: STABLE
- Stability attribution: observation_drift, inventory_drift, identity_drift

### Inventory
- Run 1 openings: door
- Run 1 fixtures: recess
- Run 1 architectural features: none
- Run 2 openings: door
- Run 2 fixtures: ac_unit, recess
- Run 2 architectural features: none

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 unused inventory: fixture:recess
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 unused inventory: fixture:recess
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"},{"wallIndex":2,"canonicalWallId":"blank_wall_2","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"ac_unit_1","primaryAnchorLabel":"ac_unit"},{"wallIndex":2,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 chosen anchors: wall_1:wall_plane, wall_2:door, wall_3:wall_plane
- Run 1 rejected anchors: none
- Run 2 chosen anchors: wall_1:wall_plane, wall_2:door, wall_3:ac_unit
- Run 2 rejected anchors: none
- Run 1 baseline confidence: 0.96
- Run 2 baseline confidence: 0.96

## job_4a87f43b
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: UNSTABLE
- Confidence stability: STABLE
- Opening stability: UNSTABLE
- Stability attribution: observation_drift, inventory_drift, identity_drift

### Inventory
- Run 1 openings: window
- Run 1 fixtures: door
- Run 1 architectural features: none
- Run 2 openings: window
- Run 2 fixtures: none
- Run 2 architectural features: none

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 unused inventory: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 unused inventory: none
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":2,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"},{"wallIndex":2,"canonicalWallId":"blank_wall_2","primaryAnchorLabel":"wall_plane"}]
- Run 1 chosen anchors: wall_1:door, wall_2:window, wall_3:wall_plane
- Run 1 rejected anchors: none
- Run 2 chosen anchors: wall_1:wall_plane, wall_2:window, wall_3:wall_plane
- Run 2 rejected anchors: none
- Run 1 baseline confidence: 1
- Run 2 baseline confidence: 1

## job_dfbe98aa
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: STABLE
- Opening stability: UNSTABLE
- Stability attribution: observation_drift, inventory_drift

### Inventory
- Run 1 openings: window
- Run 1 fixtures: recess
- Run 1 architectural features: none
- Run 2 openings: window
- Run 2 fixtures: none
- Run 2 architectural features: recess

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 unused inventory: fixture:recess
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 unused inventory: feature:recess
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 chosen anchors: wall_1:window, wall_2:wall_plane
- Run 1 rejected anchors: none
- Run 2 chosen anchors: wall_1:window, wall_2:wall_plane
- Run 2 rejected anchors: none
- Run 1 baseline confidence: 0.96
- Run 2 baseline confidence: 0.96

## job_81e485e7
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: UNSTABLE
- Confidence stability: UNSTABLE
- Opening stability: UNSTABLE
- Stability attribution: observation_drift, inventory_drift, identity_drift, confidence_drift

### Inventory
- Run 1 openings: door, walkthrough, window
- Run 1 fixtures: ac_unit, built_in_cabinet, kitchen_island, recess
- Run 1 architectural features: none
- Run 2 openings: door, walkthrough, window
- Run 2 fixtures: built_in_cabinet, kitchen_island
- Run 2 architectural features: ac_unit, recess

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: wall_3:fixture:built_in_cabinet
- Run 1 unused inventory: fixture:kitchen_island, fixture:recess
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: wall_3:fixture:built_in_cabinet, wall_4:fixture:built_in_cabinet
- Run 2 unused inventory: fixture:kitchen_island, feature:recess
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":2,"canonicalWallId":"walkthrough_1","primaryAnchorLabel":"walkthrough"},{"wallIndex":3,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"},{"wallIndex":1,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":2,"canonicalWallId":"walkthrough_1","primaryAnchorLabel":"walkthrough"},{"wallIndex":3,"canonicalWallId":"ac_unit_1","primaryAnchorLabel":"ac_unit"}]
- Run 1 chosen anchors: wall_1:walkthrough, wall_2:door, wall_3:window, wall_4:wall_plane
- Run 1 rejected anchors: wall_3:built_in_cabinet
- Run 2 chosen anchors: wall_1:walkthrough, wall_2:door, wall_3:window, wall_4:ac_unit, wall_5:wall_plane
- Run 2 rejected anchors: wall_3:built_in_cabinet, wall_4:built_in_cabinet
- Run 1 baseline confidence: 0.87
- Run 2 baseline confidence: 0.82

## job_4ceef035
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: UNSTABLE
- Opening stability: STABLE
- Stability attribution: observation_drift, inventory_drift, confidence_drift

### Inventory
- Run 1 openings: window, window
- Run 1 fixtures: none
- Run 1 architectural features: none
- Run 2 openings: window
- Run 2 fixtures: recess
- Run 2 architectural features: none

### Observation Validation
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 unused inventory: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: wall_2:opening:window
- Run 2 unused inventory: fixture:recess
- Run 2 inconsistencies: none

### Canonical Graph
- Run 1 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 wall identities: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 chosen anchors: wall_1:wall_plane, wall_2:window
- Run 1 rejected anchors: none
- Run 2 chosen anchors: wall_1:wall_plane, wall_2:window
- Run 2 rejected anchors: wall_2:window
- Run 1 baseline confidence: 1
- Run 2 baseline confidence: 0.91

