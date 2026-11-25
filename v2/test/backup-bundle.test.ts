import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  assertNotSyncedPath, assertSafeStagingPath, createBackupBundle, restoreBackupBundle, verifyBackupBundle,
} from '../src/backup-bundle.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

test('encrypted backup bundles round-trip databases, artifacts, and local files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-backup-bundle-'));
  const stagingParent = path.join(root, 'staging');
  const home = path.join(root, 'home');
  const helperRoot = path.join(root, 'helper');
  const restoredHome = path.join(root, 'restored-home');
  const restoredHelper = path.join(root, 'restored-helper');
  const passphrase = 'synthetic backup test passphrase';
  const artifactText = 'Synthetic artifact\n';
  const artifactHash = createHash('sha256').update(artifactText).digest('hex');

  const put = (base: string, relative: string, value: string) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const read = (base: string, relative: string) => fs.readFileSync(path.join(base, relative), 'utf8');

  try {
    put(home, `artifacts/${artifactHash}`, artifactText);
    put(home, 'helpers/example.txt', 'helper fixture\n');
    put(home, 'helpers/antigravity/catalog.json', '{"fixture":true}');
    for (const lock of ['catalog.lock', 'candidate-attempts.lock', 'revalidation.lock'])
      put(home, 'helpers/antigravity/' + lock, '0');
    put(home, 'automation/example.txt', 'automation fixture\n');
    const commons = new DatabaseSync(path.join(home, 'commons.sqlite'));
    try {
      // Provide the database rows the bundle and job recovery operations consume.
      commons.exec(`
        PRAGMA user_version = ${SCHEMA_VERSION};
        CREATE TABLE artifacts (sha256 TEXT NOT NULL);
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, seq INTEGER NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL,
          error TEXT, created_at TEXT, updated_at TEXT, started_at TEXT, finished_at TEXT
        );
        INSERT INTO jobs (id, seq, route, status) VALUES
          ('running-job', 1, 'codex', 'running'),
          ('queued-job', 2, 'codex', 'queued'),
          ('completed-job', 3, 'codex', 'completed');
      `);
      commons.prepare('INSERT INTO artifacts (sha256) VALUES (?)').run(artifactHash);
    } finally {
      commons.close();
    }

    const helperLocal = path.join(helperRoot, '.local');
    fs.mkdirSync(helperLocal, { recursive: true });
    const ledger = new DatabaseSync(path.join(helperLocal, 'usage.sqlite3'));
    try {
      ledger.exec("CREATE TABLE usage (entry TEXT NOT NULL); INSERT INTO usage VALUES ('synthetic ledger row');");
    } finally {
      ledger.close();
    }
    put(helperLocal, 'evidence/example.txt', 'ledger evidence fixture\n');

    const missingOut = path.join(root, 'missing-ledger.acbak.enc');
    await assert.rejects(createBackupBundle({
      home, outFile: missingOut, passphrase, helperRoot: path.join(root, 'missing-helper'), stagingParent,
    }), { code: 'HELPER_LEDGER_MISSING' });
    assert.equal(fs.existsSync(missingOut), false);

    const created = await createBackupBundle({
      home, outFile: path.join(root, 'bundle.acbak.enc'), passphrase, helperRoot, stagingParent,
    });
    const verify = (sourceFile = created.file, phrase = passphrase) =>
      verifyBackupBundle({ sourceFile, passphrase: phrase, stagingParent });
    const verified = verify();
    assert.equal(verified.sha256, created.sha256);
    assert.deepEqual(verified.manifest, created.manifest);
    assert.equal(verified.manifest.ac_schema, SCHEMA_VERSION);
    assert.equal(verified.manifest.artifact_count, 1);
    assert.equal(verified.manifest.has_helper_ledger, true);
    assert.equal(JSON.parse(fs.readFileSync(created.metaFile, 'utf8')).sha256, created.sha256);

    const restore = (destination: string, helperDestination?: string) => restoreBackupBundle({
      sourceFile: created.file, passphrase, stagingParent,
      home: destination, helperRoot: helperDestination, schemaVersion: SCHEMA_VERSION,
    });
    await assert.rejects(restore(path.join(root, 'no-helper')), { code: 'HELPER_ROOT_REQUIRED' });
    const conflict = 'automation/example.txt';
    put(restoredHome, conflict, 'existing file');
    // Fail during publication, after the helper ledger and earlier home entries have been linked.
    await assert.rejects(restore(restoredHome, restoredHelper), error => {
      assert.match(String(error), /automation[\\/]example\.txt/);
      return true;
    });
    assert.equal(read(restoredHome, conflict), 'existing file');
    for (const [base, relative] of [
      [restoredHome, 'commons.sqlite'],
      [restoredHome, `artifacts/${artifactHash}`],
      [restoredHome, '.restore.lock'],
      [restoredHelper, '.local/usage.sqlite3'],
      [restoredHelper, '.local/evidence/example.txt'],
      [restoredHelper, '.local/.restore.lock'],
    ]) assert.equal(fs.existsSync(path.join(base, relative)), false, relative);
    fs.unlinkSync(path.join(restoredHome, conflict));

    put(restoredHome, '.restore.lock', 'existing restore');
    await assert.rejects(restore(restoredHome, restoredHelper), { code: 'RESTORE_IN_PROGRESS' });
    assert.equal(read(restoredHome, '.restore.lock'), 'existing restore');
    fs.unlinkSync(path.join(restoredHome, '.restore.lock'));

    const restored = await restore(restoredHome, restoredHelper);
    assert.equal(restored.file, path.join(restoredHome, 'commons.sqlite'));
    assert.equal(restored.schema, SCHEMA_VERSION);
    assert.equal(restored.artifacts, 1);
    assert.equal(restored.helperRestored, true);
    assert.equal(restored.running, 1);
    assert.equal(restored.queued, 1);
    assert.equal(read(restoredHome, `artifacts/${artifactHash}`), artifactText);
    assert.equal(read(restoredHome, 'helpers/example.txt'), 'helper fixture\n');
    assert.equal(read(restoredHome, 'helpers/antigravity/catalog.json'), '{"fixture":true}');
    for (const lock of ['catalog.lock', 'candidate-attempts.lock', 'revalidation.lock'])
      assert.equal(fs.existsSync(path.join(restoredHome, 'helpers', 'antigravity', lock)), false);
    assert.equal(read(restoredHome, 'automation/example.txt'), 'automation fixture\n');
    assert.equal(read(restoredHelper, '.local/evidence/example.txt'), 'ledger evidence fixture\n');

    const restoredDb = new DatabaseSync(restored.file, { readOnly: true });
    try {
      assert.equal(restoredDb.prepare('SELECT sha256 FROM artifacts').get()?.sha256, artifactHash);
      assert.deepEqual(restoredDb.prepare('SELECT status FROM jobs ORDER BY seq').all().map(row => row.status),
        ['needs_review', 'cancelled', 'completed']);
    } finally {
      restoredDb.close();
    }
    const restoredLedger = new DatabaseSync(path.join(restoredHelper, '.local', 'usage.sqlite3'), { readOnly: true });
    try {
      assert.equal(restoredLedger.prepare('SELECT entry FROM usage').get()?.entry, 'synthetic ledger row');
    } finally {
      restoredLedger.close();
    }

    await assert.rejects(restore(restoredHome), { code: 'HOME_NOT_EMPTY' });
    const unusedHome = path.join(root, 'unused-home');
    await assert.rejects(restore(unusedHome, restoredHelper), { code: 'HOME_NOT_EMPTY' });
    assert.equal(fs.existsSync(path.join(unusedHome, 'commons.sqlite')), false);

    const recoveryKey = Buffer.alloc(32, 0xff);
    recoveryKey[31] = 0x0a; // Byte input must survive invalid UTF-8 and a terminal newline.
    const keyed = await createBackupBundle({
      home, outFile: path.join(root, 'keyed.acbak.enc'), recoveryKey, helperRoot, stagingParent,
    });
    assert.equal(verifyBackupBundle({ sourceFile: keyed.file, recoveryKey, stagingParent }).manifest.recovery_key_id,
      keyed.manifest.recovery_key_id);
    assert.throws(() => verifyBackupBundle({
      sourceFile: keyed.file, recoveryKey: Buffer.alloc(32, 7), stagingParent,
    }), { code: 'BAD_RECOVERY_KEY' });
    assert.throws(() => verify(keyed.file), { code: 'BAD_PASSPHRASE' });
    const keyedHome = path.join(root, 'keyed-home');
    const keyedHelper = path.join(root, 'keyed-helper');
    const keyedResult = await restoreBackupBundle({
      sourceFile: keyed.file, recoveryKey, stagingParent, home: keyedHome, helperRoot: keyedHelper, schemaVersion: SCHEMA_VERSION,
    });
    assert.ok(keyedResult.helperRestored);
    assert.equal(read(keyedHome, `artifacts/${artifactHash}`), artifactText);
    recoveryKey.fill(0);

    const syntheticToken = 'standard-backup-synthetic-token-fixture';
    put(home, 'connections/fixture.json', JSON.stringify({ token: syntheticToken }));
    put(home, 'helpers/token-fixture.txt', syntheticToken);
    await assert.rejects(createBackupBundle({
      home, outFile: path.join(root, 'credential.acbak.tar.gz'), standardArchive: true, helperRoot, stagingParent,
    }), { code: 'CREDENTIAL_IN_STANDARD_BACKUP' });
    fs.unlinkSync(path.join(home, 'helpers', 'token-fixture.txt'));

    // A stored review that quotes a bare private-key header does not block; a stored key does.
    const pemHeader = '-----' + 'BEGIN RSA PRIVATE KEY-----';
    const setError = (value: string | null) => {
      const db = new DatabaseSync(path.join(home, 'commons.sqlite'));
      try { db.prepare("UPDATE jobs SET error = ? WHERE id = 'completed-job'").run(value); } finally { db.close(); }
    };
    setError(`the fixture \`${pemHeader}\` is not a real key`);
    const quotedBundle = await createBackupBundle({
      home, outFile: path.join(root, 'pem-quoted.acbak.tar.gz'), standardArchive: true, helperRoot, stagingParent,
    });
    assert.ok(fs.existsSync(quotedBundle.file));
    for (const file of [quotedBundle.file, quotedBundle.sha256File, quotedBundle.metaFile]) fs.rmSync(file, { force: true });
    setError(`${pemHeader}\n${'MIIEowIBAAKCAQEA'.repeat(4)}`);
    await assert.rejects(createBackupBundle({
      home, outFile: path.join(root, 'pem-key2.acbak.tar.gz'), standardArchive: true, helperRoot, stagingParent,
    }), { code: 'CREDENTIAL_IN_STANDARD_BACKUP' });
    setError(null);

    const standard = await createBackupBundle({
      home, outFile: path.join(root, 'standard.acbak.tar.gz'), standardArchive: true, helperRoot, stagingParent,
    });
    const standardOptions = { sourceFile: standard.file, standardArchive: true as const, stagingParent };
    assert.equal(verifyBackupBundle(standardOptions).manifest.encrypted, false);
    assert.equal(JSON.parse(fs.readFileSync(standard.metaFile, 'utf8')).encrypted, false);
    assert.equal(standard.manifest.files.some(entry => entry.path.startsWith('openai-helper/evidence/')), false);
    assert.throws(() => verify(standard.file), { code: 'BUNDLE_CORRUPT' });
    const standardHome = path.join(root, 'standard-home');
    const standardHelper = path.join(root, 'standard-helper');
    const standardResult = await restoreBackupBundle({
      ...standardOptions, home: standardHome, helperRoot: standardHelper, schemaVersion: SCHEMA_VERSION,
    });
    assert.ok(standardResult.helperRestored);
    assert.equal(read(standardHome, `artifacts/${artifactHash}`), artifactText);
    fs.unlinkSync(standard.metaFile);
    assert.throws(() => verifyBackupBundle(standardOptions), { code: 'METADATA_MISSING' });
    fs.unlinkSync(standard.sha256File);
    assert.throws(() => verifyBackupBundle(standardOptions), { code: 'CHECKSUM_MISSING' });

    const otherArchive = path.join(root, 'unexpected.acbak.tar.gz');
    put(root, 'unrelated.txt', 'unrelated test content');
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-C', root, '-czf', otherArchive, 'unrelated.txt']);
    const otherBytes = fs.readFileSync(otherArchive);
    const otherSha = createHash('sha256').update(otherBytes).digest('hex');
    fs.writeFileSync(otherArchive + '.sha256', otherSha);
    fs.writeFileSync(otherArchive + '.meta.json', JSON.stringify({ encrypted: false, sha256: otherSha, bytes: otherBytes.length }));
    assert.throws(() => verifyBackupBundle({ ...standardOptions, sourceFile: otherArchive }), { code: 'BUNDLE_CORRUPT' });

    assert.throws(() => verify(created.file, 'a different test passphrase'), { code: 'BAD_PASSPHRASE' });
    const tamperedFile = path.join(root, 'tampered.acbak.enc');
    const ciphertext = fs.readFileSync(created.file);
    ciphertext[64] ^= 1; // The ACBAK1 ciphertext follows the 64-byte header.
    fs.writeFileSync(tamperedFile, ciphertext);
    assert.throws(() => verify(tamperedFile), { code: 'BAD_PASSPHRASE' });

    fs.writeFileSync(created.sha256File, `${'0'.repeat(64)}  ${path.basename(created.file)}\n`);
    assert.throws(() => verify(), { code: 'CHECKSUM_MISMATCH' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backup path guards reject credential files and OneDrive destinations', () => {
  for (const name of [
    'connections/operator.json', 'helpers/secrets/fixture.txt',
    'helpers/local.env', 'helpers/local.dpapi', 'helpers/local.key',
  ]) {
    assert.throws(() => assertSafeStagingPath(name), { code: 'SECRET_PATH_FORBIDDEN' });
  }
  for (const name of ['OneDrive', 'OneDrive - Example Organization']) {
    assert.throws(() => assertNotSyncedPath(path.join(os.tmpdir(), name, 'ac-home'), 'home', {}),
      { code: 'SYNC_PATH_FORBIDDEN' });
  }
});
