import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store, protectFixtureHome } from './fixtures/service.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('Store and CLI rotate tokens while preserving actor records and connection settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rotate-client-'));
  try {
    protectFixtureHome(home);
    const store = new Store(home);
    try {
      const operator = store.createActor('operator', 'operator', 'local-operator');
      const alice = store.createActor('Alice', 'participant', 'alice');
      const peer = store.createActor('Peer', 'participant', 'peer');
      store.setActorTags(alice.actor.id, 'openai', 'codex');
      const { project } = store.call(operator.actor, 'project_create', {
        name: 'Rotation project', operation_id: randomUUID(),
      });
      store.call(alice.actor, 'air_tx', {
        project_id: project.id, operation_id: randomUUID(),
        packet: '@air1\n#0 tnew "Keep this task"\n#1 ask to=peer "Keep this message"',
      });

      const snapshot = () => ({
        actors: store.db.prepare('SELECT id, name, role, family, adapter_id FROM actors ORDER BY id').all(),
        tasks: store.db.prepare('SELECT * FROM tasks').all(),
        messages: store.db.prepare('SELECT * FROM messages').all(),
      });
      const before = snapshot();
      assert.equal(before.tasks.length, 1);
      assert.equal(before.messages.length, 1);

      const direct = store.rotateActorToken(alice.actor.id);
      assert.equal(direct.actor.id, alice.actor.id);
      assert.notEqual(direct.token, alice.token);
      assert.throws(() => store.authenticate(alice.token), { code: 'UNAUTHENTICATED' });
      assert.deepEqual({ ...store.authenticate(direct.token) }, alice.actor);
      assert.deepEqual(snapshot(), before);

      const dir = path.join(home, 'connections');
      fs.mkdirSync(dir);
      const aliceFile = path.join(dir, 'alice.json');
      const peerFile = path.join(dir, 'peer.json');
      const operatorFile = path.join(dir, 'operator.json');
      const projectIds = [project.id];
      fs.writeFileSync(aliceFile, JSON.stringify({
        url: 'http://127.0.0.1:4727', token: direct.token, actorId: alice.actor.id,
        projectIds, selectProject: false, toolProfile: 'air',
      }), { mode: 0o600 });

      const run = (...args: string[]) => {
        const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli,
          'rotate-client', '--home', home, ...args], { encoding: 'utf8', windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
      const singleOutput = run('--name', 'alice', '--profile', 'full', '--url', 'http://127.0.0.1:4827');
      const single = read(aliceFile);
      assert.deepEqual(JSON.parse(singleOutput), [{ actor: 'alice', connection: aliceFile }]);
      assert.equal(singleOutput.includes(direct.token), false);
      assert.equal(singleOutput.includes(single.token), false);
      assert.equal(single.url, 'http://127.0.0.1:4827');
      assert.equal(single.toolProfile, undefined);
      assert.deepEqual(single.projectIds, projectIds);
      assert.equal(single.selectProject, false);
      assert.throws(() => store.authenticate(direct.token), { code: 'UNAUTHENTICATED' });
      assert.deepEqual({ ...store.authenticate(single.token) }, alice.actor);
      assert.deepEqual({ ...store.authenticate(peer.token) }, peer.actor);
      assert.deepEqual(snapshot(), before);

      const allOutput = run('--all', '--url', 'http://127.0.0.1:4799');
      assert.deepEqual(JSON.parse(allOutput), [
        { actor: 'alice', connection: aliceFile },
        { actor: 'local-operator', connection: operatorFile },
        { actor: 'peer', connection: peerFile },
      ]);
      for (const [file, actor, previousToken, profile] of [
        [aliceFile, alice.actor, single.token, 'air'],
        [operatorFile, operator.actor, operator.token, undefined],
        [peerFile, peer.actor, peer.token, 'air'],
      ] as const) {
        const connection = read(file);
        assert.equal(connection.url, 'http://127.0.0.1:4799');
        assert.equal(connection.actorId, actor.id);
        assert.equal(connection.toolProfile, profile);
        assert.equal(allOutput.includes(previousToken), false);
        assert.equal(allOutput.includes(connection.token), false);
        assert.throws(() => store.authenticate(previousToken), { code: 'UNAUTHENTICATED' });
        assert.deepEqual({ ...store.authenticate(connection.token) }, actor);
      }
      assert.deepEqual(read(aliceFile).projectIds, projectIds);
      assert.equal(read(aliceFile).selectProject, false);
      assert.deepEqual(snapshot(), before);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
