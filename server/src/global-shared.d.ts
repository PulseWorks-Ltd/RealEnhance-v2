// server/src/global-shared.d.ts

// Tell TypeScript “this module exists; treat everything as any”
declare module '@realenhance/shared' {
  const value: any;
  export = value;
}
