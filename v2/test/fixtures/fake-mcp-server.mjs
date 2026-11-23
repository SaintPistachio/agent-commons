// Stand-in for a tool set's stdio MCP server (shaped like the Blender wrapper's tools). Runs with cwd = a test
// directory: writes its pid to mcp.pid and logs every call to mcp-calls.log there.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

fs.writeFileSync('mcp.pid', String(process.pid));
if (process.argv.includes('--dump-env')) {
  fs.writeFileSync('mcp-env.json', JSON.stringify({
    hasPath: !!(process.env.PATH ?? process.env.Path),
    hasSystemRoot: !!(process.env.SYSTEMROOT ?? process.env.SystemRoot),
    custom: process.env.AC_TEST_VAR ?? null,
  }));
}
if (process.argv.includes('--hang')) await new Promise(resolve => setTimeout(resolve, 60000));
const tools = [
  { name: 'session_start', description: 'Start a session',
    inputSchema: { type: 'object', required: ['project_root', 'output_root'], properties: {
      project_root: { type: 'string' }, output_root: { type: 'string' },
      scene: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Scene' },
      visible: { type: 'boolean', default: false } } } },
  { name: 'get_scene_info', description: 'Inspect the scene', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string', minLength: 1 } } } },
  { name: 'get_viewport_screenshot', description: 'Capture', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, max_size: { type: 'integer', default: 1000 } } } },
  { name: 'tag_map', description: 'An open map cannot be strict', inputSchema: { type: 'object', properties: { tags: { type: 'object', additionalProperties: { type: 'string' } } } } },
  { name: 'slow', description: 'Takes three seconds', inputSchema: { type: 'object', properties: {} } },
  { name: 'execute_blender_code', description: 'Edit only', inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } },
];
const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  fs.appendFileSync('mcp-calls.log', JSON.stringify({ name, args }) + '\n');
  if (name === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
  if (name === 'get_viewport_screenshot') return { content: [{ type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' }] };
  if (name === 'get_scene_info') return { content: [{ type: 'text', text: 'objects: Cube, Light, Camera ' + 'x'.repeat(20000) }] };
  return { content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }] };
});
await server.connect(new StdioServerTransport());
