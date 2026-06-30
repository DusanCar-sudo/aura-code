import type { HistoryMessage } from '../providers/types.js';
export interface SessionMessage {
  id: string; role: string; content: string;
  toolName?: string; toolInput?: Record<string, unknown>;
  timestamp: number; turns?: number; toolCount?: number;
}
export class Session {
  private history: HistoryMessage[] = [];
  private display: SessionMessage[] = [];
  private n = 0;
  getHistory() { return [...this.history]; }
  getDisplay() { return [...this.display]; }
  addUser(content: string) { this.history.push({role:'user',content}); this.display.push({id:'m'+(++this.n),role:'user',content,timestamp:Date.now()}); }
  addAssistant(content: string, turns=0, toolCount=0) { this.display.push({id:'m'+(++this.n),role:'assistant',content,timestamp:Date.now(),turns,toolCount}); }
  addTool(toolName: string, toolInput: Record<string,unknown>, content: string) { this.display.push({id:'m'+(++this.n),role:'tool_call',toolName,toolInput,content,timestamp:Date.now()}); }
  reset() { this.history=[]; this.display=[]; }
}
