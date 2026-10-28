import assert from 'node:assert/strict';
import test from 'node:test';
import type { TUI } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { installSidebar } from '../lib/shell-sidebar-layout.ts';
import { sidebarHeader, sidebarPart } from '../lib/shell-sidebar.ts';
import { activitySummary, acceptedJobs, acceptedWaits, commandRows, safeJobLabel, createWaitsReceiver } from '../lib/shell-activity-state.ts';
test('session-scoped jobs reject malformed and foreign snapshots', () => {
 const snapshot={jobs:[{id:'j',label:'Build preview',startedAt:1000}]};
 assert.equal(acceptedJobs('mine',{sessionId:'other',snapshot}),undefined);
 assert.equal(acceptedJobs('mine',{sessionId:'mine',snapshot:{jobs:[{id:'j',label:'x',startedAt:NaN}]}}),undefined);
 assert.deepEqual(acceptedJobs('mine',{sessionId:'mine',snapshot}),snapshot.jobs);
 assert.equal(acceptedJobs(undefined,{sessionId:undefined,snapshot}),undefined);
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
test('scoped waits event feeds the tabbed background rows and pinned count', t => {
 const listeners=new Map<string,(value:unknown)=>void>(); const events={on:(name:string,fn:(value:unknown)=>void)=>{listeners.set(name,fn);return ()=>listeners.delete(name);},emit:(name:string,value:unknown)=>listeners.get(name)?.(value)};
 let session='one'; const root={render:()=>[],invalidate(){},[Symbol.for('@earendil-works/pi-tui/layout-node')]:()=>({type:'vstack',entries:[]})};
 const tui={mode:'fullscreen',terminal:{columns:160},layoutRoot:root,requestRender(){}} as unknown as TUI;
 const receiver=createWaitsReceiver(events,()=>session,()=>tui.requestRender());
 sidebarHeader(tui,{digest:()=> 'header',render:()=>['MODEL'],invalidate(){}});
 sidebarPart(tui,'footer',{digest:()=> 'status',render:()=>['STATUS'],invalidate(){}});
 sidebarPart(tui,'activity',{digest:()=>JSON.stringify(receiver.current()),waitsCount:()=>receiver.current()?.length,render:()=>commandRows([],120001,receiver.current()),invalidate(){}});
 t.after(installSidebar(tui,{fg:(_c,s)=>s,bold:s=>s},()=> 'auto',()=> 'top',undefined,undefined,{tabs:true})); t.after(()=>receiver.dispose());
 const frame=()=>renderLayoutFrame(root,160,20,()=>{}).lines.join('\n');
 events.emit('background-waits:pending',{waits:[]}); assert.match(frame(),/Waits unavailable/);
 events.emit('background-waits:pending',{sessionId:'one',waits:[{id:'w',label:'CI check',startedAt:1}]}); assert.match(frame(),/Wait · CI check · 2m/); assert.match(frame(),/Waits 1/);
 events.emit('background-waits:pending',{sessionId:'other',waits:[]}); assert.match(frame(),/CI check/);
 events.emit('background-waits:pending',{sessionId:'one',waits:[]}); assert.match(frame(),/No local waits/);
 session='two'; assert.match(frame(),/Waits unavailable/);
});
test('default labels never publish the raw command', () => {
 assert.equal(safeJobLabel('long command', 'long command'), 'Background command');
 assert.equal(safeJobLabel('build job', 'long command'), 'build job');
 assert.equal(safeJobLabel('job: long command', 'long command'), 'Background command');
});
test('summary does not turn unknown agents, commands or waits into zero', () => {
 assert.match(activitySummary(undefined,undefined),/Agents \?/);
 assert.match(activitySummary(undefined,undefined),/Commands \?/);
 assert.match(activitySummary({active:2,attention:1},1),/2 active.*1 waiting.*1 command/);
 assert.match(commandRows(undefined, 1000).join('\n'),/Commands unavailable/);
 assert.match(commandRows([], 1000).join('\n'),/No running commands/);
 assert.match(commandRows([], 1000).join('\n'),/Waits unavailable/);
 assert.match(commandRows([{id:'j',label:'build',startedAt:0}], 120000).join('\n'),/build.*running.*2m/);
});
