/**
 * dsh-a2a-server — bundle entry.
 *
 * DSH bundle patches resolve the package root entry (`index.js`) directly, so
 * this file re-exports the built host implementation from `lib/index.js`.
 */
export * from './lib/index.js'
