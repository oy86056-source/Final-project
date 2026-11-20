import { randomUUID } from 'node:crypto';

export class ORAError extends Error {
  constructor(message, { code = 'ORA_ERROR', details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class ConfigError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'CONFIG_ERROR', details, cause });
  }
}

export class SecurityError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'SECURITY_ERROR', details, cause });
  }
}

export class PermissionError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'PERMISSION_ERROR', details, cause });
  }
}

export class ApprovalError extends PermissionError {
  constructor(message = 'Approval denied', details = {}) {
    super(message, { code: 'APPROVAL_DENIED', ...details });
  }
}

export class TimeoutError extends ORAError {
  constructor(message = 'Operation timed out', details = {}, cause) {
    super(message, { code: 'TIMEOUT', details, cause });
  }
}

export class ToolError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'TOOL_ERROR', details, cause });
  }
}

export class ProviderError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'PROVIDER_ERROR', details, cause });
  }
}

export class AdapterError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'ADAPTER_ERROR', details, cause });
  }
}

export class TaskError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'TASK_ERROR', details, cause });
  }
}

export class AgentError extends ORAError {
  constructor(message, details = {}, cause) {
    super(message, { code: 'AGENT_ERROR', details, cause });
  }
}

export function errorRecord(error) {
  if (error instanceof ORAError) return error.toJSON();
  if (error instanceof Error) {
    return { name: error.name, code: 'ERROR', message: error.message };
  }
  return { name: 'UnknownError', code: 'ERROR', message: String(error) };
}

export function newId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
