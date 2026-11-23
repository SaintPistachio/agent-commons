#!/usr/bin/env node
// Records a scheduled automation's result in Agent Commons as a checkpoint, and optionally a message to an app.
//
//   node ac-report.mjs --summary TEXT --project PROJECT --connection NAME [--task TASK] [--fail] [--next TEXT]
//                      [--rev SHA] [--br BRANCH] [--home DIR]
//                      [--ask-to ACTOR] [--op KEY]
//
// Exit 0 when recorded, 1 when the service could not be reached (the caller keeps its own log either way).
import { acHome, airTx, flag, loadConnection, openDb, option, projectId, q } from './ac-client.mjs';

const home = option('home') ?? acHome();
const projectRef = option('project');
const connectionRef = option('connection');
if (!projectRef || !connectionRef) { console.error('--project and --connection are required'); process.exit(1); }
const connection = loadConnection(connectionRef, home);
if (!connection) { console.error('no connection file'); process.exit(1); }
const summary = option('summary');
if (!summary) { console.error('--summary is required'); process.exit(1); }
const endpoint = new URL(connection.url);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
  console.error('The connection must target the local loopback service.'); process.exit(1);
}
const db = await openDb(home);
const project = projectId(db, projectRef);
db.close();
if (!project) { console.error('No matching local project.'); process.exit(1); }
const task = option('task');
const next = option('next');
const askTo = option('ask-to');
const rev = option('rev'), br = option('br');
let packet = `@air1\n#0 chk ${q(summary)}${task ? ` t=${q(task)}` : ''}${rev ? ` rev=${q(rev)}` : ''}${br ? ` br=${q(br)}` : ''}${flag('fail') ? ' fail=1' : ''}${next ? ` next=${q(next)}` : ''}`;
if (askTo) packet += `\n#1 ask to=${q(askTo)} ${q(summary + (next ? ' Next: ' + next : ''))}${task ? ` t=${q(task)}` : ''}`;
const op = option('op', `report:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
try {
  console.log(await airTx(connection, project, packet, op));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
