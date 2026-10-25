import { RyuuError, ToolError, ToolNotFoundError, ValidationError } from '../utils/errors.js';
import { validateSchema } from '../utils/validation.js';

export const RISK_LEVELS = ['read', 'write', 'exec', 'destructive'];
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,60}$/;

/**
 * Define a tool with validation. Every tool is: name, description, JSON schema,
 * a risk level, an async handler, and optional preview/approval metadata.
 */
export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new ToolError('Tool definition must be an object.');
  const { name, description, schema, risk = 'read', handler, preview = null, requiresApproval } = definition;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new ToolError(`Invalid tool name: ${JSON.stringify(name)} (expected lowercase snake_case).`);
  }
  if (typeof description !== 'string' || description.trim().length < 10) {
    throw new ToolError(`Tool ${name} needs a descriptive description.`);
  }
  if (!schema || schema.type !== 'object' || typeof schema.properties !== 'object') {
    throw new ToolError(`Tool ${name} needs an object JSON schema with properties.`);
  }
  if (!RISK_LEVELS.includes(risk)) {
    throw new ToolError(`Tool ${name} has invalid risk "${risk}" (allowed: ${RISK_LEVELS.join(', ')}).`);
  }
  if (typeof handler !== 'function') throw new ToolError(`Tool ${name} needs a handler function.`);
  if (preview !== null && typeof preview !== 'function') throw new ToolError(`Tool ${name} preview must be a function.`);
  return Object.freeze({
    ...definition,
    risk,
    requiresApproval: requiresApproval ?? risk !== 'read',
  });
}

export class ToolRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.tools = new Map();
    this.plugins = new Map();
  }

  register(toolDefinition) {
    const tool = defineTool(toolDefinition);
    if (this.tools.has(tool.name)) {
      throw new ToolError(`Tool name collision: ${tool.name} is already registered.`);
    }
    this.tools.set(tool.name, tool);
    this.logger?.debug('tool registered', { name: tool.name, risk: tool.risk });
    return tool;
  }

  /**
   * Register a group of tools as a plugin. Collisions with built-ins fail loudly
   * so a plugin can never silently shadow workspace tooling.
   */
  registerPlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') throw new ToolError('Plugin must be an object.');
    const name = String(plugin.name || '');
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(name)) throw new ToolError(`Invalid plugin name: ${JSON.stringify(plugin.name)}`);
    if (this.plugins.has(name)) throw new ToolError(`Plugin already registered: ${name}`);
    if (!Array.isArray(plugin.tools) || plugin.tools.length === 0) throw new ToolError(`Plugin ${name} must expose at least one tool.`);
    const prepared = plugin.tools.map((tool) => defineTool(tool));
    for (const tool of prepared) {
      if (this.tools.has(tool.name)) {
        throw new ToolError(`Plugin ${name} tool collision: ${tool.name} is already registered.`);
      }
    }
    for (const tool of prepared) this.tools.set(tool.name, tool);
    this.plugins.set(name, { name, version: plugin.version || '0.0.0', toolNames: prepared.map((t) => t.name) });
    return { name, tools: prepared.map((t) => t.name) };
  }

  get(name) {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()];
  }

  /** OpenAI-compatible tool schemas for chat.completions. */
  toOpenAITools() {
    return this.list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    }));
  }

  /** Validate arguments and run the handler. Unknown tools cannot execute. */
  async execute(name, args, ctx = {}) {
    const tool = this.get(name);
    const errors = validateSchema(tool.schema, args ?? {});
    if (errors.length > 0) {
      throw new ValidationError(`Invalid arguments for ${name}: ${errors.join('; ')}`, { tool: name, errors });
    }
    const startedAt = Date.now();
    try {
      const result = await tool.handler(args ?? {}, ctx);
      return { result, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
      // Preserve actionable semantics (path escape, secret block, approvals...).
      if (error instanceof RyuuError) throw error;
      throw new ToolError(`Tool ${name} failed: ${error.message}`, { tool: name, cause: error?.message });
    }
  }
}

