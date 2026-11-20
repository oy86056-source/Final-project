export const SPECIALISTS = Object.freeze([
  {
    id: 'architect',
    name: 'Architect',
    purpose: 'Analyze repository structure and propose an implementation approach',
    tools: ['repo.scan', 'repo.search', 'repo.context', 'fs.read', 'fs.list', 'git.status'],
    readOnly: true
  },
  {
    id: 'coder',
    name: 'Coder',
    purpose: 'Implement controlled file changes and focused code generation',
    tools: ['repo.scan', 'repo.search', 'repo.context', 'fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec', 'git.status', 'git.diff'],
    readOnly: false
  },
  {
    id: 'tester',
    name: 'Tester',
    purpose: 'Run tests, builds and linters and analyze failures',
    tools: ['repo.scan', 'repo.context', 'fs.read', 'shell.exec', 'git.diff'],
    readOnly: false
  },
  {
    id: 'researcher',
    name: 'Researcher',
    purpose: 'Find relevant code, documentation and available capabilities',
    tools: ['repo.scan', 'repo.search', 'repo.context', 'fs.read', 'fs.list', 'config.show', 'adapter.execute'],
    readOnly: true
  },
  {
    id: 'security',
    name: 'Security',
    purpose: 'Review changes for unsafe commands, secret exposure and path violations',
    tools: ['repo.scan', 'repo.search', 'repo.context', 'fs.read', 'git.diff', 'shell.exec'],
    readOnly: true
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    purpose: 'Review results and verification evidence before task completion',
    tools: ['repo.scan', 'repo.context', 'fs.read', 'git.diff', 'repo.search'],
    readOnly: true
  }
]);

export function createAgentRegistry() {
  const registry = new Map(SPECIALISTS.map((agent) => [agent.id, { ...agent, tools: [...agent.tools] }]));

  return {
    register(definition) {
      if (!definition || typeof definition.id !== 'string' || !/^[a-z0-9-]+$/.test(definition.id)) {
        throw new Error('invalid agent id');
      }
      if (!Array.isArray(definition.tools)) throw new Error('agent tools must be an array');
      const record = {
        id: definition.id,
        name: definition.name || definition.id,
        purpose: definition.purpose || '',
        tools: [...definition.tools],
        readOnly: definition.readOnly !== false,
        systemPrompt: definition.systemPrompt || ''
      };
      registry.set(record.id, record);
      return { ...record };
    },
    get(id) {
      const found = registry.get(String(id));
      return found ? { ...found, tools: [...found.tools] } : undefined;
    },
    list() {
      return [...registry.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ ...agent, tools: [...agent.tools] }));
    },
    has(id) {
      return registry.has(String(id));
    }
  };
}
