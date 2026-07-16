// Kanban Pipeline Module
export { startKanbanServer } from './server.js';
export type { KanbanServerOptions } from './server.js';
export { runPipeline, getBoardTasks, getRowLabels } from './pipeline.js';
export type { OnProgress, PipelineOptions } from './pipeline.js';
export type {
  KanbanTask, PipelinePhase, PipelineRow, TaskStatus,
  PhaseResult, TaskExecution, PipelineReport, RowReport, ProgressEvent,
} from './types.js';

// Standalone Kanban Server (agent-agnostic)
export { createStandaloneKanbanApp, startStandaloneKanbanServer } from './standalone-server.js';
export type { StandaloneKanbanOptions } from './standalone-server.js';

// MCP Tool Wrapper
export { kanbanMoveTool, kanbanBoardTool, handleKanbanMove, handleKanbanBoard } from './mcp-tool.js';
export type { MCPToolDef, MoveResult } from './mcp-tool.js';
