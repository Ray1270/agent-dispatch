import { claudeAdapter } from './claude.mjs';
import { codexAdapter } from './codex.mjs';
import { dshAdapter } from './dsh.mjs';
import { geminiAdapter } from './gemini.mjs';
import { qwenAdapter } from './qwen.mjs';

const registry = new Map([
  [codexAdapter.id, codexAdapter],
  [dshAdapter.id, dshAdapter],
  [claudeAdapter.id, claudeAdapter],
  [geminiAdapter.id, geminiAdapter],
  [qwenAdapter.id, qwenAdapter],
]);

/**
 * Register or override a worker adapter at runtime.
 * @param {Record<string, any>} adapter
 */
export function registerAdapter(adapter) {
  if (!adapter || !adapter.id) {
    throw new Error('Adapter must define a non-empty `id`.');
  }
  registry.set(adapter.id, adapter);
}

/**
 * Check whether an adapter ID is registered.
 * @param {string} id
 * @returns {boolean}
 */
export function hasAdapter(id) {
  return registry.has(String(id || ''));
}

/**
 * Retrieve an adapter by ID or throw a descriptive error.
 * @param {string} id
 */
export function getAdapter(id) {
  const key = String(id || '');
  const adapter = registry.get(key);
  if (!adapter) {
    throw new Error(
      `Unsupported worker "${key}". Available adapters: ${listAdapterIds().join(', ')}.`
    );
  }
  return adapter;
}

/**
 * List all registered adapter IDs.
 * @returns {string[]}
 */
export function listAdapterIds() {
  return Array.from(registry.keys());
}

/**
 * Return all registered adapter descriptors.
 */
export function getAllAdapters() {
  return Array.from(registry.values());
}
