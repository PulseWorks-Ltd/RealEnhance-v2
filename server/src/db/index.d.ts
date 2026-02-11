export declare const pool: any;
export declare function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T>;
