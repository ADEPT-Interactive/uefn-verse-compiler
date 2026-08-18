import type { WorkflowEndpoint } from '../types.js';

export const COMPILER_ENDPOINT_ENV = 'UEFN_VERSE_COMPILER_ENDPOINT';
export const COMPILER_HOST_ENV = 'UEFN_VERSE_WORKFLOW_HOST';
export const COMPILER_PORT_ENV = 'UEFN_VERSE_WORKFLOW_PORT';

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1';
}

function parsePort(value: string | undefined, variableName: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${variableName} must be a valid TCP port.`);
  return port;
}

function parseEndpoint(value: string, sourceName: string): WorkflowEndpoint {
  const candidate = value.trim().replace(/^tcp:\/\//i, '');
  let host: string;
  let portText: string;
  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close < 0 || candidate[close + 1] !== ':') throw new Error(`${sourceName} must use host:port syntax.`);
    host = candidate.slice(1, close);
    portText = candidate.slice(close + 2);
  } else {
    const separator = candidate.lastIndexOf(':');
    if (separator <= 0) throw new Error(`${sourceName} must use host:port syntax.`);
    host = candidate.slice(0, separator);
    portText = candidate.slice(separator + 1);
  }
  if (!isLoopbackHost(host)) throw new Error(`${sourceName} must target local loopback.`);
  return { host, port: parsePort(portText, sourceName) };
}

export function validateWorkflowEndpoint(endpoint: WorkflowEndpoint): WorkflowEndpoint {
  if (!endpoint || typeof endpoint.host !== 'string' || !isLoopbackHost(endpoint.host)) throw new Error('Verse compiler endpoints must target local loopback.');
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('Verse compiler endpoint must use a valid TCP port.');
  return { host: endpoint.host, port: endpoint.port };
}

/** Resolve only an explicit development/test override. Normal callers use process discovery. */
export function resolveWorkflowEndpoint(environment: NodeJS.ProcessEnv = process.env): WorkflowEndpoint {
  const explicit = environment[COMPILER_ENDPOINT_ENV]?.trim();
  if (explicit) return parseEndpoint(explicit, COMPILER_ENDPOINT_ENV);
  const legacyHost = environment[COMPILER_HOST_ENV];
  const legacyPort = environment[COMPILER_PORT_ENV];
  if (legacyHost !== undefined || legacyPort !== undefined) {
    const host = (legacyHost ?? '127.0.0.1').trim();
    if (!host) throw new Error(`${COMPILER_HOST_ENV} must not be empty.`);
    if (!isLoopbackHost(host)) throw new Error(`${COMPILER_HOST_ENV} must target local loopback.`);
    return { host, port: parsePort(legacyPort, COMPILER_PORT_ENV) };
  }
  throw new Error(`No ${COMPILER_ENDPOINT_ENV} override is configured; automatic UEFN discovery is required.`);
}

export function hasEndpointOverride(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment[COMPILER_ENDPOINT_ENV]?.trim())
    || environment[COMPILER_HOST_ENV] !== undefined
    || environment[COMPILER_PORT_ENV] !== undefined;
}
