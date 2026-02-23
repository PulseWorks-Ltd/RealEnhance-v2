/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: {
        // Override NodeNext for Jest compat — Jest resolves CJS paths at runtime
        module: "CommonJS",
        moduleResolution: "node",
        target: "ES2022",
        esModuleInterop: true,
        skipLibCheck: true,
        noImplicitAny: false,
        // Include jest types so jest.fn(), expect, describe etc. resolve
        types: ["jest", "node"],
        // Resolve @realenhance/shared to workspace source
        // Both patterns needed: one strips .js ext (NodeNext imports), one for bare paths
        paths: {
          "@realenhance/shared": ["../shared/src/index"],
          "@realenhance/shared/*.js": ["../shared/src/*"],
          "@realenhance/shared/*": ["../shared/src/*"],
        },
        baseUrl: ".",
      },
    }],
  },
  // Map .js extension imports to their .ts originals for Jest's CommonJS resolver
  moduleNameMapper: {
    // Strip .js from relative imports (e.g. ../foo.js -> ../foo)
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // Strip .js from @realenhance/shared sub-path imports and resolve to source
    "^@realenhance/shared/(.*)\\.js$": "<rootDir>/../shared/src/$1",
    // @realenhance/shared sub-path imports without .js
    "^@realenhance/shared/(.*)$": "<rootDir>/../shared/src/$1",
  },
};
