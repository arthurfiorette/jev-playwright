import createDebug from 'debug';

// Separate namespaces allow callers to enable reporter or selection diagnostics independently.
export const reporterDebug = createDebug('jev-playwright:reporter');
export const selectionDebug = createDebug('jev-playwright:selection');
