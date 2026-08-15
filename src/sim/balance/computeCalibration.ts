/**
 * End-to-end model-system work omitted by the dominant 2N inference and 6ND
 * training approximations. The uplift covers non-GEMM attention/norm/logit
 * work, collectives, checkpoint/recompute traffic, and mandatory runtime
 * orchestration. It deliberately excludes hardware utilization, numerical
 * precision, architecture, facility PUE, and redundancy; those are modeled
 * independently downstream and must not be charged here a second time.
 */
export const MODEL_SYSTEMS_WORK_MULTIPLIER = 1.35

