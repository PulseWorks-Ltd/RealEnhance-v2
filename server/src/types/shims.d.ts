// server/src/global-shared.d.ts

// Minimal typings for the shared workspace package used by the server.
// We only declare what the server actually imports right now.

declare module '@realenhance/shared' {
  // Loosely typed – enough for TS to be happy, runtime uses the real implementation
  export function findByPublicUrlRedis(...args: any[]): Promise<any>;
}
