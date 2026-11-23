import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readConnection, call, RemoteError } from './client.ts';
import { listedTools, toolsFor, profileOf, PROJECT_SCOPED } from './tools.ts';
import { toolReply, toolError } from './mcp-reply.ts';

/**
 * stdio MCP bridge: node v2/src/mcp.ts --connection <file>. The file is re-read per call. Its optional toolProfile
 * picks the catalog: "full" (default, every tool) or "air" (air_sync, air_tx, air_get, art_put only).
 */
const index = process.argv.indexOf('--connection'), file = index >= 0 ? process.argv[index + 1] : undefined;
if (!file) throw new Error('CONNECTION_FILE_REQUIRED');

const server = new Server({ name: 'agent-commons', version: '2.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(profileOf(readConnection(file).toolProfile)) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name, input: Record<string, unknown> = { ...(request.params.arguments ?? {}) };
  let airProfile = false;
  try {
    const connection = readConnection(file), profile = profileOf(connection.toolProfile);
    airProfile = profile === 'air';
    if (!toolsFor(profile).has(name)) throw new RemoteError('UNKNOWN_TOOL', name);
    if (PROJECT_SCOPED.has(name) && input.project_id === undefined && connection.projectIds?.length === 1 && !connection.selectProject)
      input.project_id = connection.projectIds[0];
    return toolReply(name, await call(connection, name, input));
  } catch (error) {
    return toolError(name, error, input, airProfile);
  }
});
await server.connect(new StdioServerTransport());
