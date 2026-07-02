# Baseline Determinism Phase 4 - Canonical Graph Reconciliation and Confidence

Generated: 2026-07-01T03:11:13.399Z

- Total images: 6
- Inventory-stable images: 2
- Observation-stable images: 0
- Canonical-graph-stable images: 0
- Identity-stable images: 4
- Confidence-stable images: 4
- Final-status-stable images: 6
- MATCHED images: 5
- RECONCILED images: 1
- IRRECONCILABLE images: 0

## job_c11a8e7c
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: UNSTABLE
- Final baseline status stability: STABLE
- Run 1 status: MATCHED
- Run 2 status: MATCHED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: none
- Run 2 actions: none
- Run 2 reasons: none

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 0.96
- Run 2 confidence: 1

## job_bb029607
- Inventory stability: STABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: STABLE
- Final baseline status stability: STABLE
- Run 1 status: MATCHED
- Run 2 status: MATCHED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: none
- Run 2 actions: none
- Run 2 reasons: none

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"ac_unit_1","primaryAnchorLabel":"ac_unit"},{"wallIndex":2,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"ac_unit_1","primaryAnchorLabel":"ac_unit"},{"wallIndex":2,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 0.96
- Run 2 confidence: 0.96

## job_4a87f43b
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: UNSTABLE
- Confidence stability: STABLE
- Final baseline status stability: STABLE
- Run 1 status: MATCHED
- Run 2 status: MATCHED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: none
- Run 2 actions: none
- Run 2 reasons: none

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":2,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"},{"wallIndex":2,"canonicalWallId":"blank_wall_2","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 1
- Run 2 confidence: 1

## job_dfbe98aa
- Inventory stability: STABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: STABLE
- Final baseline status stability: STABLE
- Run 1 status: MATCHED
- Run 2 status: MATCHED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: none
- Run 2 actions: none
- Run 2 reasons: none

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 0.96
- Run 2 confidence: 0.96

## job_81e485e7
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: UNSTABLE
- Confidence stability: STABLE
- Final baseline status stability: STABLE
- Run 1 status: RECONCILED
- Run 2 status: RECONCILED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: wall_4:fixture:built_in_cabinet, wall_3:fixture:built_in_cabinet
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: wall_3:fixture:built_in_cabinet, wall_4:fixture:built_in_cabinet
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: wall_4:fixture:built_in_cabinet, wall_3:fixture:built_in_cabinet, wall_4:fixture:built_in_cabinet
- Run 2 actions: wall_3:identity_disagreement_wall_plane_vs_ac_unit
- Run 2 reasons: wall_3:fixture:built_in_cabinet, wall_4:fixture:built_in_cabinet

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":2,"canonicalWallId":"walkthrough_1","primaryAnchorLabel":"walkthrough"},{"wallIndex":3,"canonicalWallId":"ac_unit_1","primaryAnchorLabel":"ac_unit"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"door_1","primaryAnchorLabel":"door"},{"wallIndex":1,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":2,"canonicalWallId":"walkthrough_1","primaryAnchorLabel":"walkthrough"},{"wallIndex":3,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 0.74
- Run 2 confidence: 0.74

## job_4ceef035
- Inventory stability: UNSTABLE
- Observation stability: UNSTABLE
- Canonical graph stability: UNSTABLE
- Identity stability: STABLE
- Confidence stability: UNSTABLE
- Final baseline status stability: STABLE
- Run 1 status: MATCHED
- Run 2 status: MATCHED

### Validation Failures
- Run 1 unknown references: none
- Run 1 duplicate references: none
- Run 1 inconsistencies: none
- Run 2 unknown references: none
- Run 2 duplicate references: none
- Run 2 inconsistencies: none

### Reconciliation Actions
- Run 1 actions: none
- Run 1 reasons: none
- Run 2 actions: none
- Run 2 reasons: none

### Canonical Graph
- Run 1 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 2 graph: [{"wallIndex":0,"canonicalWallId":"window_1","primaryAnchorLabel":"window"},{"wallIndex":1,"canonicalWallId":"blank_wall_1","primaryAnchorLabel":"wall_plane"}]
- Run 1 confidence: 1
- Run 2 confidence: 0.96

