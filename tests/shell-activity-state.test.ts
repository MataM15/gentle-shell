import assert from 'node:assert/strict';
import test from 'node:test';
import type { TUI } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { installSidebar } from '../lib/shell-sidebar-layout.ts';
import { sidebarHeader, sidebarPart } from '../lib/shell-sidebar.ts';
import { activitySummary, activitySummaryRows, acceptedJobs, acceptedWaits, commandRows, safeJobLabel, createWaitsReceiver } from '../lib/shell-activity-state.ts';
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
test('wait snapshots require the current session and well-formed rows', () => {
 const event={sessionId:'here',waits:[{id:'w',label:'CI',startedAt:5}]};
 assert.deepEqual(acceptedWaits('here',event),event.waits);
 assert.deepEqual(acceptedWaits('here',{sessionId:'here',waits:[]}),[]);
 assert.equal(acceptedWaits('elsewhere',event),undefined);
 assert.equal(acceptedWaits('here',{waits:event.waits}),undefined);
 assert.equal(acceptedWaits('here',{...event,waits:[{id:'',label:'CI',startedAt:5}]}),undefined);
 assert.equal(acceptedWaits('here',{...event,waits:[{id:'w',label:'CI',startedAt:Infinity}]}),undefined);
 assert.equal(acceptedWaits('here',{...event,waits:[{id:'w',label:3,startedAt:5}]}),undefined);
 assert.equal(acceptedWaits('here',{...event,waits:[{id:'w',label:'CI',startedAt:0}]}),undefined);
});
test('wait event receiver rejects legacy and foreign payloads, clears, and resets on replacement', () => {
 let listener: (value:unknown)=>void = () => {}; let session='one'; let changes=0;
 const receiver=createWaitsReceiver({on:(_name,fn)=>{listener=fn;return ()=>{};}},()=>session,()=>{changes++;});
 const row={id:'w',label:'CI check',startedAt:1};
 listener({waits:[row]}); assert.equal(receiver.current(),undefined);
 listener({sessionId:'other',waits:[row]}); assert.equal(receiver.current(),undefined);
 listener({sessionId:'one',waits:[row]}); assert.deepEqual(receiver.current(),[row]);
 listener({waits:[row]}); assert.equal(receiver.current(),undefined, 'an unscoped producer cannot leave a stale known count');
 listener({sessionId:'one',waits:[row]});
 listener({sessionId:'one',waits:[]}); assert.deepEqual(receiver.current(),[]);
 listener({sessionId:'one',waits:[row]}); session='two'; assert.equal(receiver.current(),undefined);
 receiver.reset(); assert.equal(receiver.current(),undefined); assert.equal(changes,6);
 receiver.dispose();
});
test('scoped waits event feeds the receiver, never a foreign session, and clears on replacement', t => {
 const listeners=new Map<string,(value:unknown)=>void>(); const events={on:(name:string,fn:(value:unknown)=>void)=>{listeners.set(name,fn);return ()=>listeners.delete(name);},emit:(name:string,value:unknown)=>listeners.get(name)?.(value)};
 let session='one';
 const receiver=createWaitsReceiver(events,()=>session,()=>{}); t.after(()=>receiver.dispose());
 events.emit('background-waits:pending',{waits:[]}); assert.equal(receiver.current(), undefined);
 events.emit('background-waits:pending',{sessionId:'one',waits:[{id:'w',label:'CI check',startedAt:1}]}); assert.deepEqual(receiver.current(),[{id:'w',label:'CI check',startedAt:1}]);
 events.emit('background-waits:pending',{sessionId:'other',waits:[]}); assert.match(JSON.stringify(receiver.current()),/CI check/, 'a foreign session cannot clear the local waits');
 events.emit('background-waits:pending',{sessionId:'one',waits:[]}); assert.deepEqual(receiver.current(),[]);
 session='two'; assert.equal(receiver.current(), undefined, 'a replacement session starts empty');
});
test('default labels never publish the raw command', () => {
 assert.equal(safeJobLabel('long command', 'long command'), 'Background command');
 assert.equal(safeJobLabel('build job', 'long command'), 'build job');
 assert.equal(safeJobLabel('job: long command', 'long command'), 'Background command');
});
test('summary does not turn unknown agents, commands or waits into zero or a question mark', () => {
 assert.match(activitySummary(undefined,undefined),/Agents —/);
 assert.match(activitySummary(undefined,undefined),/Commands —/);
 assert.match(activitySummary(undefined,undefined),/Waits —/);
 assert.doesNotMatch(activitySummary(undefined,undefined),/\?/);
 assert.match(activitySummary({active:2,attention:1},1),/2 active.*1 waiting.*1 command/);
 assert.match(commandRows(undefined, 1000).join('\n'),/Commands unavailable/);
 assert.match(commandRows([], 1000).join('\n'),/No running commands/);
 assert.match(commandRows([], 1000).join('\n'),/Waits unavailable/);
 assert.match(commandRows([{id:'j',label:'build',startedAt:0}], 120000).join('\n'),/build.*running.*2m/);
});

test('activity summary rows label each fact and never turn an unknown value into a zero or a question mark', () => {
 assert.deepEqual(activitySummaryRows(undefined,undefined,undefined),[
  {label:'Agents',value:'—'},{label:'Commands',value:'—'},{label:'Waits',value:'—'},
 ]);
 assert.deepEqual(activitySummaryRows({active:1,attention:0},0,0),[
  {label:'Agents',value:'1 active · 0 waiting'},{label:'Commands',value:'0 commands'},{label:'Waits',value:'0'},
 ]);
 assert.deepEqual(activitySummaryRows({active:2,attention:1},1,1)[1],{label:'Commands',value:'1 command'});
 assert.equal(activitySummaryRows({active:2,attention:1},undefined,undefined)[0].value,'2 active · 1 waiting','a known fact stays known beside unknown ones');
 for(const row of activitySummaryRows(undefined,undefined,undefined)) assert.doesNotMatch(row.value,/\?/);
});
