import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresencePublisher } from '../lib/orchestrator-presence.ts';
import { projectSessionPage, createSessionRefresh, readSessionSnapshot, acceptedSessionSnapshot, sessionRows } from '../lib/shell-session-state.ts';

test('bounded peer projection distinguishes empty, incomplete, and unavailable metadata', () => {
 const header=(id:string, recent:boolean)=>({sessionHash:id,incarnation:'synthetic',schema:1 as const,label:'Peer name',heartbeat:1,generation:1,counts:{running:2,queued:1,waiting:1,finished:9},digest:null,unavailable:null,recent});
 assert.deepEqual(projectSessionPage({entries:[],scanned:0,rejected:0,overflow:false},'self',1),{kind:'ready',rows:[],incomplete:false,observedAt:1});
 assert.equal(projectSessionPage({entries:[],scanned:0,rejected:0,overflow:false,unavailable:'missing'},'self').kind,'unavailable');
 const result=projectSessionPage({entries:[header('self',true),header('peer',false)],scanned:2,rejected:0,overflow:true},'self');
 assert.equal(result.kind,'ready'); if(result.kind==='ready') { assert.equal(result.rows.length,1); assert.equal(result.rows[0]!.freshness,'stale'); assert.equal(result.rows[0]!.active,4); assert.equal(result.incomplete,true); }
 const duplicate=projectSessionPage({entries:[header('peer',true),header('peer',false)],scanned:2,rejected:0,overflow:false},'self',1);
 assert.deepEqual(duplicate,{kind:'ready',rows:[],incomplete:true,observedAt:1});
});
test('snapshot validation is bounded, session scoped, and distinguishes no peers from unavailable', () => {
 const ready={kind:'ready',rows:[{name:'Peer',freshness:'recent',active:2}],incomplete:false,observedAt:1};
 assert.deepEqual(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:ready}),ready);
 assert.equal(acceptedSessionSnapshot('two',{sessionId:'one',snapshot:ready}),undefined);
 assert.equal(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:{...ready,rows:Array(9).fill(ready.rows[0])}}),undefined);
 assert.equal(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:{...ready,rows:[{name:'x',freshness:'alive',active:0}]}}),undefined);
 assert.deepEqual(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:{...ready,rows:[{...ready.rows[0],lastSeen:2}]}}),{...ready,rows:[{...ready.rows[0],lastSeen:2}]});
 assert.equal(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:{...ready,rows:[{...ready.rows[0],lastSeen:-1}]}}),undefined);
 assert.match(sessionRows({kind:'ready',rows:[],incomplete:false,observedAt:1},1).join('\n'),/Sin otras sesiones/);
 assert.match(sessionRows({kind:'ready',rows:[],incomplete:true,observedAt:1},1).join('\n'),/lista parcial/);
 assert.match(sessionRows(undefined).join('\n'),/unavailable/);
});
test('synthetic same-profile publisher projects headers without exposing session ids', (t) => {
 const profile=mkdtempSync(join(tmpdir(),'sidebar-session-'));
 t.after(()=>rmSync(profile,{recursive:true,force:true}));
 const self=PresencePublisher.start({profile,sessionId:'current',label:'Mine',activity:[]});
 const peer=PresencePublisher.start({profile,sessionId:'other',label:'Peer topic',activity:[]});
 try {
  const result=readSessionSnapshot(profile,'current');
  assert.equal(result.kind,'ready');
  if (result.kind==='ready') {
   assert.equal(result.rows.length,1);
   assert.equal(result.rows[0]!.name,'Peer topic'); assert.equal(result.rows[0]!.freshness,'recent'); assert.equal(result.rows[0]!.active,0);
   assert.equal(typeof result.rows[0]!.lastSeen,'number');
  }
  assert.doesNotMatch(JSON.stringify(result),/current|other/);
 } finally { self.dispose(); peer.dispose(); }
});
test('snapshot prioritizes recent records and labels the bounded observation time and all counted states', () => {
 const header=(id:string,recent:boolean)=>({sessionHash:id,incarnation:'synthetic',schema:1 as const,label:id,heartbeat:1,generation:1,counts:{running:2,queued:1,waiting:1,finished:9},digest:null,unavailable:null,recent});
 const page={entries:[...Array.from({length:8},(_,i)=>header(`stale${i}`,false)),header('recent',true)],scanned:9,rejected:0,overflow:false};
 const result=projectSessionPage(page,'self',Date.UTC(2026,0,2,3,4,5));
 assert.equal(result.kind,'ready'); if(result.kind!=='ready') return;
 assert.equal(result.rows[0]!.name,'recent'); assert.equal(result.rows.length,8); assert.equal(result.incomplete,true);
 assert.deepEqual(sessionRows(result,Date.UTC(2026,0,2,3,4,5)).slice(-1),['visto hace 0 s · lista parcial']);
 assert.equal(result.rows[1]!.lastSeen,1);
 assert.equal(acceptedSessionSnapshot('one',{sessionId:'one',snapshot:{...result,observedAt:NaN}}),undefined);
});
test('asynchronous refresh discards stale successes and failures for old parent sessions', async () => {
 let current='a'; const pending:Array<{resolve:(value:any)=>void;reject:(error:Error)=>void}>=[]; const published:any[]=[];
 const refresh=createSessionRefresh(()=>current,()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),(session,value)=>published.push({session,value}));
 refresh.request(); await Promise.resolve(); current='b'; refresh.request(); await Promise.resolve(); pending[0]!.resolve({kind:'ready',rows:[],incomplete:false}); await new Promise<void>((resolve)=>setImmediate(resolve));
 assert.deepEqual(published,[]); pending[1]!.resolve({kind:'ready',rows:[],incomplete:false}); await new Promise<void>((resolve)=>setImmediate(resolve)); assert.equal(published[0]?.session,'b');
 refresh.request(); await Promise.resolve(); current='c'; pending[2]!.reject(new Error('failed')); await new Promise<void>((resolve)=>setImmediate(resolve)); assert.equal(published.length,1);
 refresh.dispose();
});
