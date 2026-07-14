import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCiVersion } from '../../scripts/ci-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('CI package versioning', () => {
  it('uses the tag version for releases', () => {
    assert.equal(resolveCiVersion({
      GITHUB_REF: 'refs/tags/v1.2.3',
      GITHUB_REF_NAME: 'v1.2.3',
      GITHUB_RUN_NUMBER: '42',
    }), '1.2.3');
  });

  it('uses a path-safe prerelease version for pull requests and manual runs', () => {
    assert.equal(resolveCiVersion({
      GITHUB_REF: 'refs/pull/123/merge',
      GITHUB_REF_NAME: '123/merge',
      GITHUB_RUN_NUMBER: '42',
    }), '0.0.0-ci.42');
    assert.equal(resolveCiVersion({
      GITHUB_REF: 'refs/heads/master',
      GITHUB_REF_NAME: 'master',
      GITHUB_RUN_NUMBER: '43',
    }), '0.0.0-ci.43');
  });

  it('uses the tested CI version resolver instead of raw pull-request ref names', () => {
    const workflow = readFileSync(
      resolve(REPO_ROOT, '.github', 'workflows', 'build.yml'),
      'utf8',
    );

    assert.match(workflow, /scripts\/ci-version\.mjs/);
    assert.doesNotMatch(workflow, /VERSION="\$\{GITHUB_REF_NAME#v\}"/);
  });
});
