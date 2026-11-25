import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { containsCredentialMaterial, databaseHoldsCredentialMaterial, KNOWN_TEST_CREDENTIAL_SHA256 } from '../src/backup-bundle.ts';

// Values here are built at run time so this file never contains a credential-shaped literal itself.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => fs.readFileSync(path.join(here, name)).toString('latin1');
const none: ReadonlySet<string> = new Set();
const header = (kind: string) => '-----' + `BEGIN ${kind}-----`;
const footer = (kind: string) => '-----' + `END ${kind}-----`;
const rsa = 'RSA PRIVATE KEY';
const line = 'MIIEowIBAAKCAQEAw1x2y3z4' + 'Ab9+/Cd8'.repeat(5); // a 64-character base64 body line
const realKey = `${header(rsa)}\n${line}\n${line}\n${footer(rsa)}`;
const mention = `the fixture \`${header(rsa)}\` in ops.test.ts is not a real key`;

test('the tracked test fixtures are skipped, and each allowlisted hash is still in use', () => {
  for (const name of ['host-audit.test.ts', 'ops.test.ts']) {
    const text = source(name);
    assert.equal(containsCredentialMaterial(text, none), true, `${name} no longer holds a credential-shaped fixture`);
    assert.equal(containsCredentialMaterial(text), false, `${name} holds a credential-shaped value that is not allowlisted`);
  }
  assert.equal(KNOWN_TEST_CREDENTIAL_SHA256.size, 2);
  // A staged diff that quotes both tests is what blocked the nightly cloud backup.
  const diff = ['+++ b/v2/test/host-audit.test.ts', ...source('host-audit.test.ts').split('\n').map(l => `+${l}`),
    '+++ b/v2/test/ops.test.ts', ...source('ops.test.ts').split('\n').map(l => `+${l}`)].join('\n');
  assert.equal(containsCredentialMaterial(diff), false);
});

test('credential-shaped values that are not the exact fixtures still block', () => {
  const gh = 'ghp' + '_' + 'Q7'.repeat(18);
  const openai = 'sk-' + 'proj-' + 'Zx9'.repeat(25);
  const slack = 'xox' + 'b-' + '1234567890-abcdefghij';
  const google = 'AIza' + 'z'.repeat(35);
  const gemini = 'AQ.' + 'z'.repeat(48);
  for (const value of [gh, openai, slack, google, gemini]) assert.equal(containsCredentialMaterial(`token = '${value}'`), true);

  // The fixture token with extra characters is a different value.
  const fixture = /ghp_[A-Za-z0-9]{36,}/.exec(source('host-audit.test.ts'))![0];
  assert.equal(containsCredentialMaterial(`x ${fixture}A y`), true);
  assert.equal(containsCredentialMaterial(`fixture ${fixture} then real ${gh}`), true);

  // A private key is judged by its whole block: a different body, no END, or an oversized block all block.
  assert.equal(containsCredentialMaterial(`${header(rsa)}\\nabd\\n${footer(rsa)}`), true);
  assert.equal(containsCredentialMaterial(realKey), true);
  assert.equal(containsCredentialMaterial(`${header('PRIVATE KEY')}\nMIIEvQ`), true);
  assert.equal(containsCredentialMaterial(`${header(rsa)}\n${'A'.repeat(5000)}\n${footer(rsa)}`), true);
  assert.equal(containsCredentialMaterial(`${header('OPENSSH PRIVATE KEY')}\nb3Bl\n${footer(rsa)}`), true);
  assert.equal(containsCredentialMaterial('no secrets here'), false);
  // Raw file bytes keep failing closed on a bare header, quoted or not.
  assert.equal(containsCredentialMaterial(mention), true);
});

test('in one stored value, a quoted bare header passes and anything that could carry a key blocks', () => {
  const m = (text: string) => containsCredentialMaterial(text, KNOWN_TEST_CREDENTIAL_SHA256, 'mention');
  // Representative values from a database: backtick or quote right after the header, then prose.
  assert.equal(m(mention), false);
  assert.equal(m(`redact '${header(rsa)}' to a placeholder?`), false);
  assert.equal(m(`"${header(rsa)}"`), false);
  assert.equal(m(`quoted \`${header(rsa)}\` at commit ${'0123456789abcdef'.repeat(2)}01234567 and job 00000000-0000`), false, 'a Git SHA is not a key line');
  assert.equal(m(`see \`${header(rsa)}\` in C:/ExampleWorkspace/SampleProject/scripts/Watch and v2/test/ops.test.ts`), false, 'paths are not key lines');
  assert.equal(m(`\`${header(rsa)}\`\nsrc/AgentCommons/v2/BackupBundle/Fixture12345\n`), false, 'a bare path line is not a key line');
  assert.equal(m(header(rsa)), true, 'a header that ends the text may continue in the next cell');
  const shortLines = Array.from({ length: 200 }, (_, i) => `Ab3+${String(i).padStart(4, '0')}Cd9/EfGh7IjKl5Mn`.slice(0, 32));
  assert.equal(m(JSON.stringify([header(rsa), ...shortLines, footer(rsa)])), true, 'a whole key in a JSON array, END beyond 4 KB');
  assert.equal(m(`\`${header(rsa)}\` then ${'.'.repeat(5000)} ${footer(rsa)}`), true, 'a matching END within 64 KB');

  const truncatedLine = line.slice(0, 40);
  assert.equal(m(`${header(rsa)}\n${truncatedLine}`), true, 'truncated key, real newline');
  assert.equal(m(`${header(rsa)}\\n${truncatedLine}`), true, 'JSON-escaped newline');
  assert.equal(m(`${header(rsa)}\\u000a${truncatedLine}`), true, 'JSON unicode-escaped newline');
  assert.equal(m(`${header(rsa)}&#10;${truncatedLine}`), true, 'HTML-escaped newline');
  assert.equal(m(`${header(rsa)} ${truncatedLine}`), true, 'space-separated body');
  assert.equal(m(`${header(rsa)}\nProc-Type: 4,ENCRYPTED`), true, 'encrypted PEM');
  assert.equal(m(`["${header(rsa)}","${line}"`), true, 'key stored as an array of lines, quote after the header');
  assert.equal(m(`\`${header(rsa)}\` ${'x'.repeat(10)} ${line}`), true, 'a body line after a quoted header');
  assert.equal(m(realKey), true);
  assert.equal(m(`${mention}\n${realKey}`), true, 'a mention does not hide a later key');
});

test('a staged database is compacted and scanned cell by cell', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-credential-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const make = (setup: (db: DatabaseSync) => void) => {
    const file = path.join(dir, `db${n++}.sqlite`);
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT, data BLOB); CREATE VIRTUAL TABLE memory_fts USING fts5(primary_text, secondary_text)');
      db.prepare('INSERT INTO messages (body) VALUES (?)').run('ordinary text');
      setup(db);
    } finally { db.close(); }
    return file;
  };

  // A review result, a message and the memory index that quote a bare header.
  const quoted = make(db => {
    db.prepare('INSERT INTO messages (body) VALUES (?)').run(mention);
    db.prepare('INSERT INTO memory_fts (primary_text, secondary_text) VALUES (?, ?)').run('review', mention);
  });
  assert.equal(databaseHoldsCredentialMaterial(quoted), false);

  assert.equal(databaseHoldsCredentialMaterial(make(db => db.prepare('INSERT INTO messages (body) VALUES (?)').run(realKey))), true, 'text cell');
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.prepare('INSERT INTO messages (data) VALUES (?)').run(Buffer.from(realKey)))), true, 'blob cell');
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.prepare('INSERT INTO memory_fts (primary_text, secondary_text) VALUES (?, ?)').run('x', realKey))), true, 'FTS table');
  const big = `${'filler '.repeat(20000)}${realKey}`; // spans overflow pages in the file
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.prepare('INSERT INTO messages (body) VALUES (?)').run(big))), true, 'large value');
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.exec(`CREATE TABLE note (x TEXT DEFAULT '${'ghp' + '_' + 'R'.repeat(36)}')`))), true, 'schema SQL');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    db.exec('CREATE TABLE pair (a TEXT, b TEXT)');
    db.prepare('INSERT INTO pair VALUES (?, ?)').run('ghp' + '_', 'R7'.repeat(18));
  })), true, 'a token split across adjacent columns');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    db.exec('CREATE TABLE pair (a TEXT, b TEXT)');
    db.prepare('INSERT INTO pair VALUES (?, ?)').run(header(rsa), `${line}\n${line}`);
  })), true, 'a key split across columns');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    const insert = db.prepare('INSERT INTO messages (body) VALUES (?)');
    insert.run(`"${header(rsa)}"`);
    for (let i = 0; i < 3; i++) insert.run(line);
  })), true, 'a key split across rows after a quoted header');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    db.exec('CREATE TABLE big (n INTEGER)');
    db.prepare('INSERT INTO big VALUES (?)').run(9007199254740993n);
  })), false, 'integers beyond 2^53 are read');
  const token = Buffer.from('synthetic-connection-token-value-0001');
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.exec(`CREATE TABLE note (x TEXT DEFAULT '${token}')`)), [token]), true, 'connection token in schema SQL');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    db.exec('CREATE TABLE pair (a TEXT, b TEXT)');
    db.prepare('INSERT INTO pair VALUES (?, ?)').run('x'.repeat(5000) + token.toString().slice(0, 10), token.toString().slice(10));
  }), [token]), true, 'connection token split across fields that cross a page');
  assert.equal(databaseHoldsCredentialMaterial(make(db => {
    db.exec('CREATE TABLE pair (a TEXT, b TEXT)');
    db.prepare('INSERT INTO pair VALUES (?, ?)').run('x'.repeat(5000) + 'ghp' + '_', '1'.repeat(36));
  })), true, 'token shape split across fields that cross a page');
  assert.equal(databaseHoldsCredentialMaterial(make(db => db.prepare('INSERT INTO messages (body) VALUES (?)').run(`t=${token}`)), [token]), true, 'connection token');

  // A deleted key leaves no free page behind: the file no longer holds its bytes after the scan.
  const deleted = make(db => {
    db.prepare('INSERT INTO messages (body) VALUES (?)').run(big);
    db.exec('DELETE FROM messages WHERE length(body) > 1000');
  });
  assert.equal(databaseHoldsCredentialMaterial(deleted), false);
  assert.equal(fs.readFileSync(deleted).includes(Buffer.from(line)), false, 'VACUUM removed the deleted key');

  // Read errors fail closed.
  const broken = path.join(dir, 'broken.sqlite');
  fs.writeFileSync(broken, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x41)]));
  assert.throws(() => databaseHoldsCredentialMaterial(broken));
});
