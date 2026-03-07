// server/src/global-shared.d.ts

// Minimal typings for the shared workspace package used by the server.
// We only declare what the server actually imports right now.

declare module '@realenhance/shared' {
  // Loosely typed – enough for TS to be happy, runtime uses the real implementation
  export function findByPublicUrlRedis(...args: any[]): Promise<any>;

  export type FairShareDecision = {
    canStart: boolean;
    activeUsers: number;
    maxJobsPerUser: number;
    userActiveJobs: number;
    totalSlots: number;
  };

  export function canStartJob(userId: string): Promise<boolean>;
  export function evaluateFairShare(userId: string): Promise<FairShareDecision>;
  export function getActiveJobsByUser(): Promise<Record<string, number>>;
  export function markJobStarted(userId: string): Promise<void>;
  export function markJobFinished(userId: string): Promise<void>;
}
