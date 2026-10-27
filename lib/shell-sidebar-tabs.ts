export type SidebarTab = 'activity' | 'sessions' | 'resources' | 'status';
export const SIDEBAR_TABS: ReadonlyArray<{ id: SidebarTab; label: string; start: number; end: number }> = [
 { id: 'activity', label: 'Activity', start: 0, end: 10 },
 { id: 'sessions', label: 'Sessions', start: 11, end: 21 },
 { id: 'resources', label: 'Resources', start: 22, end: 33 },
 { id: 'status', label: 'Status', start: 34, end: 42 },
];
export function sidebarTabSections(tab: SidebarTab): readonly string[] {
 switch (tab) {
  case 'activity': return ['agents', 'todo'];
  case 'sessions': return [];
  case 'resources': return ['usage'];
  case 'status': return ['footer'];
 }
}
