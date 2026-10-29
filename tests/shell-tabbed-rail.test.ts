import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderLayoutFrame, type LayoutBox } from '@earendil-works/pi-tui/dist/layout.js';
import { ScrollView, type Component, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { installSidebar, invalidateSidebar } from '../lib/shell-sidebar-layout.ts';
import { sidebarHeader, sidebarPart } from '../lib/shell-sidebar.ts';
import { cardStyle, setCardStyle, CARD_STYLE } from '../lib/shell-card.ts';

const NODE = Symbol.for('@earendil-works/pi-tui/layout-node');
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
function fixture(headerPlacement: 'top' | 'below-input' = 'top') {
 const root = { render: () => ['transcript'], invalidate() {}, [NODE]: () => ({type:'vstack', entries:[]}) };
 const host = { mode:'fullscreen', terminal:{columns:160}, layoutRoot:root, requestRender() {} };
 const tui = host as unknown as TUI;
 const count = { wellness:0, agents:0, usage:0, footer:0 };
 let current = 'one';
 sidebarHeader(tui, { digest: () => current, render: () => [`MODEL ${current}`], invalidate() {} });
 for (const key of Object.keys(count) as Array<keyof typeof count>) sidebarPart(tui, key, {
  digest: () => key === 'wellness' ? current : key,
  render: () => { count[key]++; return key === 'agents' ? [] : [key.toUpperCase()]; }, invalidate() {},
 });
 const dispose = installSidebar(tui, theme, () => 'auto', () => headerPlacement, undefined, undefined, {tabs:true});
 const frame = () => renderLayoutFrame(root, host.terminal.columns, 24, () => {});
 const find = (box: LayoutBox): Component | undefined => box.children.length === 0 && box.component.render(box.rect.width).some(s => s.includes('Activity') && s.includes('Resources')) ? box.component : box.children.map(find).find(Boolean);
 const select = (label: string) => {
  const pinned = find(frame().root)!; assert.ok(pinned);
  const rows = pinned.render(50), y = rows.findIndex(s => s.includes('Activity') && s.includes('Resources')), x = rows[y]!.indexOf(label);
  assert.ok(x >= 0);
  const event = { type:'click', button:'left', x, y, width:50, height:rows.length, screenX:110+x, screenY:y, shift:false, alt:false, ctrl:false } as TuiMouseEvent;
  assert.equal(pinned.handleMouse?.(event)?.handled, true);
 };
 return {root, host, tui, count, frame, find, select, dispose, setHeader:(v:string) => {current=v;}};
}
test('production sidebar opts into the tested tabbed layout', () => {
 const source=readFileSync(new URL('../extensions/gentle-shell.ts',import.meta.url),'utf8');
 assert.match(source, /installSidebar\(tui, theme,[\s\S]*?tabs: true, onTabSelect:/);
});
test('enabled rail keeps header and Wellness pinned, empty Activity navigable, and hidden sections cached', t => {
 const f=fixture(); t.after(f.dispose);
 let frame=f.frame(); let text=frame.lines.join('\n');
 assert.match(text, /MODEL one/); assert.match(text, /WELLNESS/); assert.match(text, /Activity.*Sessions.*Resources.*Status/);
 assert.match(text, /No activity/); assert.doesNotMatch(text, /USAGE|FOOTER/);
 assert.deepEqual(f.count, {wellness:1, agents:1, usage:0, footer:0});
 f.frame(); assert.deepEqual(f.count, {wellness:1, agents:1, usage:0, footer:0});
 f.select('Resources'); frame=f.frame(); text=frame.lines.join('\n'); assert.match(text,/USAGE/); assert.doesNotMatch(text,/FOOTER/);
 assert.equal(f.count.wellness,1); assert.equal(f.count.usage,1); assert.equal(f.count.footer,0);
 f.select('Sessions'); assert.match(f.frame().lines.join('\n'),/Sessions unavailable/);
 f.select('Status'); assert.match(f.frame().lines.join('\n'),/FOOTER/);
 invalidateSidebar(f.tui); f.frame(); assert.equal(f.count.footer,1); assert.equal(f.count.usage,1); assert.equal(f.count.agents,1);
 f.setHeader('two'); assert.match(f.frame().lines.join('\n'),/MODEL two/);
});
test('pinned wellness repaints only on its own displayed change and keeps its click coordinates', t => {
 const root={render:()=>[],invalidate(){},[NODE]:()=>({type:'vstack',entries:[]})};
 const host={mode:'fullscreen',terminal:{columns:160},layoutRoot:root,requestRender(){}}; const tui=host as unknown as TUI;
 let wellness='BREAKS 1', status='STATUS 1', count=0; let hit: TuiMouseEvent | undefined;
 sidebarHeader(tui,{digest:()=> 'model',render:()=>['MODEL'],invalidate(){}});
 sidebarPart(tui,'wellness',{digest:()=>wellness,render:()=>{count++;return [wellness,'RESET'];},invalidate(){},handleMouse(e){hit=e;return {handled:true};}});
 sidebarPart(tui,'footer',{digest:()=>status,render:()=>[status],invalidate(){}});
 t.after(installSidebar(tui,theme,()=> 'auto',()=> 'top',undefined,undefined,{tabs:true}));
 const frame=()=>renderLayoutFrame(root,160,24,()=>{});
 const find=(box:LayoutBox):Component|undefined=>box.children.length===0 && box.component.render(box.rect.width).some(s=>s.includes('Activity')&&s.includes('Status')) ? box.component : box.children.map(find).find(Boolean);
 let pinned=find(frame().root)!; assert.equal(count,1);
 const event=(x:number,y:number):TuiMouseEvent=>({type:'click',button:'left',x,y,width:50,height:pinned.render(50).length,screenX:110+x,screenY:y,shift:false,alt:false,ctrl:false} as TuiMouseEvent);
 let lines=pinned.render(50); let tabY=lines.findIndex(s=>s.includes('Activity')); let resetY=lines.findIndex(s=>s.includes('RESET'));
 assert.equal(pinned.handleMouse?.(event(lines[tabY]!.indexOf('Status'),tabY))?.handled,true);
 pinned=find(frame().root)!; assert.equal(count,1, 'tab switch keeps wellness cached');
 status='STATUS 2'; frame(); invalidateSidebar(tui); frame(); assert.equal(count,1, 'unrelated changes do not repaint wellness');
 wellness='BREAKS 2'; pinned=find(frame().root)!; assert.equal(count,2); assert.match(pinned.render(50).join('\n'),/BREAKS 2/);
 frame(); assert.equal(count,2, 'one repaint for changed displayed text');
 lines=pinned.render(50); resetY=lines.findIndex(s=>s.includes('RESET'));
 assert.equal(pinned.handleMouse?.(event(2,resetY))?.handled,true); assert.equal(hit?.x,1); assert.equal(hit?.y,1);
});
test('a card style change invalidates pinned section cache', t => {
 const initial=cardStyle(); t.after(()=>setCardStyle(initial));
 const f=fixture(); t.after(f.dispose); f.frame(); assert.equal(f.count.wellness,1);
 setCardStyle(initial === CARD_STYLE.NEON ? CARD_STYLE.FLOAT : CARD_STYLE.NEON);
 f.frame(); assert.equal(f.count.wellness,2);
});
test('activity counts remain pinned across tabs and update without rendering hidden agents', t => {
 const root={render:()=>[],invalidate(){},[NODE]:()=>({type:'vstack',entries:[]})};
 const host={mode:'fullscreen',terminal:{columns:160},layoutRoot:root,requestRender(){}}; const tui=host as unknown as TUI;
 let active=2, attention=1, jobs: number | undefined=1, renders=0;
 sidebarHeader(tui,{digest:()=> 'model',render:()=>['MODEL'],invalidate(){}});
 sidebarPart(tui,'agents',{digest:()=>String(active),activitySummary:()=>({active,attention}),render:()=>{renders++;return ['AGENTS'];},invalidate(){}});
 sidebarPart(tui,'activity',{digest:()=>String(jobs),commandsCount:()=>jobs,render:()=>['COMMANDS'],invalidate(){}});
 sidebarPart(tui,'footer',{digest:()=> 'status',render:()=>['STATUS'],invalidate(){}});
 t.after(installSidebar(tui,theme,()=> 'auto',()=> 'top',undefined,undefined,{tabs:true}));
 const frame=()=>renderLayoutFrame(root,160,24,()=>{});
 const find=(box:LayoutBox):Component|undefined=>box.children.length===0 && box.component.render(box.rect.width).some(s=>s.includes('Activity')&&s.includes('Status')) ? box.component : box.children.map(find).find(Boolean);
 let view=frame(); assert.match(view.lines.join('\n'),/Agents 2 active.*1 waiting.*1 command/); assert.equal(renders,1);
 let pinned=find(view.root)!; let rows=pinned.render(50), y=rows.findIndex(s=>s.includes('Activity')), x=rows[y]!.indexOf('Status');
 const click={type:'click',button:'left',x,y,width:50,height:rows.length,screenX:110+x,screenY:y,shift:false,alt:false,ctrl:false} as TuiMouseEvent;
 assert.equal(pinned.handleMouse?.(click)?.handled,true); view=frame(); assert.match(view.lines.join('\n'),/STATUS/);
 active=3; attention=2; jobs=undefined; view=frame();
 assert.match(view.lines.join('\n'),/Agents 3 active.*2 waiting.*Commands \?/); assert.equal(renders,1, 'hidden Agents is not repainted');
 pinned=find(view.root)!; rows=pinned.render(50); assert.match(rows.join('\n'),/Agents 3 active/);
});
test('full activity summary fits the fixed rail without dropping counts', t => {
 const root={render:()=>[],invalidate(){},[NODE]:()=>({type:'vstack',entries:[]})};
 const host={mode:'fullscreen',terminal:{columns:160},layoutRoot:root,requestRender(){}}; const tui=host as unknown as TUI;
 sidebarPart(tui,'agents',{digest:()=> 'a',activitySummary:()=>({active:12345,attention:67890}),render:()=>['AGENTS'],invalidate(){}});
 sidebarPart(tui,'activity',{digest:()=> 'b',commandsCount:()=>12345,waitsCount:()=>67890,render:()=>['COMMANDS'],invalidate(){}});
 t.after(installSidebar(tui,theme,()=> 'auto',()=> 'top',undefined,undefined,{tabs:true}));
 const view=renderLayoutFrame(root,160,24,()=>{}); const text=view.lines.join('\n');
 assert.match(text,/Agents 12345 active/); assert.match(text,/67890 waiting/); assert.match(text,/12345 commands/); assert.match(text,/Waits 67890/); assert.doesNotMatch(text,/…/);
});
test('tab hit geometry rejects stale digest and resized terminal', t => {
 const f=fixture(); t.after(f.dispose); const pinned=f.find(f.frame().root)!;
 const lines=pinned.render(50), y=lines.findIndex(s=>s.includes('Activity')), x=lines[y]!.indexOf('Status');
 const event={type:'click',button:'left',x,y,width:50,height:lines.length,screenX:110+x,screenY:y,shift:false,alt:false,ctrl:false} as TuiMouseEvent;
 f.setHeader('changed'); assert.equal(pinned.handleMouse?.(event),undefined);
 f.frame(); f.host.terminal.columns=139; assert.equal(pinned.handleMouse?.(event),undefined);
});
test('tabbed rail pins Wellness while scrolling and restores native layout when folded, narrow or regular', t => {
 const root={render:()=>['transcript'],invalidate(){},[NODE]:()=>({type:'vstack',entries:[]})};
 const host={mode:'fullscreen',terminal:{columns:160},layoutRoot:root,requestRender(){}}; const tui=host as unknown as TUI;
 let folded=false;
 const control={collapsed:()=>folded,toggle:()=>{folded=!folded;},hint:()=> 'alt+h'};
 sidebarHeader(tui,{render:()=>['MODEL'],invalidate(){}});
 sidebarPart(tui,'wellness',{render:()=>['BREAKS'],invalidate(){}});
 sidebarPart(tui,'todo',{render:()=>Array.from({length:50},(_,i)=>`task ${i}`),invalidate(){}});
 t.after(installSidebar(tui,theme,()=> 'auto',()=> 'top',undefined,control,{tabs:true}));
 const frame=()=>renderLayoutFrame(root,host.terminal.columns,20,()=>{});
 let view=frame(); const right=view.root.children[1]!;
 const scroll=right.children.find(box=>box.component instanceof ScrollView)?.component as ScrollView; assert.ok(scroll);
 scroll.scrollBy(7); view=frame(); assert.equal(scroll.scrollTop,7); assert.match(view.lines.join('\n'),/BREAKS/); assert.match(view.lines.join('\n'),/Activity.*Resources/);
 const footer=right.children.at(-1)!.component;
 const event={type:'click',button:'left',x:3,y:0,width:50,height:1,screenX:113,screenY:19,shift:false,alt:false,ctrl:false} as TuiMouseEvent;
 assert.equal(footer.handleMouse?.(event)?.handled,true); assert.equal(folded,true); assert.notEqual(root[NODE]().type,'hstack');
 control.toggle(); assert.equal(root[NODE]().type,'hstack');
 host.terminal.columns=139; assert.notEqual(root[NODE]().type,'hstack');
 host.terminal.columns=160; host.mode='regular'; assert.notEqual(root[NODE]().type,'hstack');
 host.mode='fullscreen'; assert.equal(root[NODE]().type,'hstack');
});
test('below-input keeps model outside pinned rail while Wellness and tabs stay pinned', t => {
 const f=fixture('below-input'); t.after(f.dispose); const text=f.frame().lines.join('\n');
 assert.doesNotMatch(text,/MODEL one/); assert.match(text,/WELLNESS/); assert.match(text,/Activity.*Resources/);
});
