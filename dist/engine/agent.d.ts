export type NativeToolName = 'system.status' | 'system.processes' | 'system.screenshot' | 'system.exec' | 'workspace.search' | 'workspace.edit' | 'workspace.exec';
export interface AgentTask {
    domain: 'coding' | 'agriculture' | 'accounting' | 'documents' | 'research' | 'engineering' | 'medicine';
    instruction: string;
}
export declare class OpenArvaAgent {
    private memory;
    private readonly autonomousTools;
    private readonly telegramConnector;
    private readonly whatsappConnector;
    private autonomousRuntime?;
    private autonomousToolsInitialized;
    private systemPersona;
    private initializeAutonomousTools;
    registerAutonomousTool(tool: import('./autonomous.js').AutonomousTool): void;
    private createAutonomousRuntime;
    executeAutonomousTask(goal: string): Promise<import("./autonomous.js").AutonomousTaskRecord>;
    resumeAutonomousTask(taskId: string): Promise<import("./autonomous.js").AutonomousTaskRecord>;
    resumeRecoverableAutonomousTasks(): Promise<import("./autonomous.js").AutonomousTaskRecord[]>;
    executeTask(task: AgentTask): Promise<string>;
    executeNativeTool(name: NativeToolName | undefined, input: Record<string, unknown>, context?: {
        taskId?: string;
        operationId?: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    respond(prompt: string, domain?: AgentTask['domain']): Promise<string>;
    private isSuspiciousCommand;
}
