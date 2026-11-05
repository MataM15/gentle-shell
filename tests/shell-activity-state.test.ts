import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedJobs } from '../lib/shell-activity-state.ts';
test('session-scoped jobs reject malformed and foreign snapshots', () => {
 const snapshot={jobs:[{id:'j',label:'Build preview',startedAt:1000}]};
 assert.equal(acceptedJobs('mine',{sessionId:'other',snapshot}),undefined);
 assert.equal(acceptedJobs('mine',{sessionId:'mine',snapshot:{jobs:[{id:'j',label:'x',startedAt:NaN}]}}),undefined);
 assert.deepEqual(acceptedJobs('mine',{sessionId:'mine',snapshot}),snapshot.jobs);
 assert.equal(acceptedJobs(undefined,{sessionId:undefined,snapshot}),undefined);
});
test('accepted jobs publish only the projected fields and drop producer extras', () => {
 const snapshot={jobs:[{id:'j',label:'Build preview',startedAt:1000,command:'RAW_COMMAND_SENTINEL',cwd:'/repo',pid:42}]};
 const accepted=acceptedJobs('mine',{sessionId:'mine',snapshot});
 assert.deepEqual(accepted,[{id:'j',label:'Build preview',startedAt:1000}]);
 assert.doesNotMatch(JSON.stringify(accepted),/RAW_COMMAND_SENTINEL|\/repo/);
});
