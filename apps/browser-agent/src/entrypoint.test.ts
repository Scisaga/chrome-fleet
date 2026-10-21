import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the executable Agent entrypoint actually starts and reports invalid startup safely',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./index.js',import.meta.url))],{
    encoding:'utf8',timeout:10000,
    env:{...process.env,AGENT_CONFIG_FILE:'/nonexistent-fleet-entrypoint-test/config.json'},
  });
  assert.equal(result.status,1,result.stderr);
  assert.ok(['ROOT_BROWSER_FORBIDDEN','BROWSER_OPERATION_FAILED'].includes(JSON.parse(result.stderr.trim()).code));
});
