export { createRuntime, PROJECT_ROOT } from './core/runtime.js';
export * from './core/index.js';
export { createRepoIntelligence, detectProject, searchRepository, assembleContext, sanitizeExternalText, inspectGit } from './repo-intelligence/index.js';
export { createAgentSystem, createAgentRegistry, SPECIALISTS, planSteps } from './agents/index.js';
export { createToolRegistry } from './tools/index.js';
export { createShellExecutor, createPatchEngine, generateUnifiedDiff } from './execution/index.js';
export { createAdapterRegistry, createAdapterLifecycle, registerBuiltins } from './adapters/index.js';
export { createProviderRegistry, createRouter, registerFreeLLMAPI } from './providers/index.js';
export { createPermissions, createApprovalGate, redact, redactObject } from './security/index.js';
