// 由 vendored 算法经 tsc 宽松模式生成，随上游同步再生；实现文件禁止手改
export declare const MARK = "Spine extract.";
export declare const RAIL_TOKENS = 32000;
export declare const TRUNK_SCOPE = "dynamic-v1";
export declare function estimateTokens(text: string): number;
export declare function sourceRole(role: string | undefined | null): string;
export interface CardSpan {
    id?: number;
    role: string;
    text: string;
    isError?: boolean;
    command?: string;
    name?: string;
    filePath?: string;
    toolCallId?: string;
    turn?: number | null;
    backgroundStart?: boolean;
    seq?: number;
    callSeq?: number;
    pointer?: string;
    known?: boolean;
    inCut?: boolean;
}
export declare function repeatedNames(text: string): Set<string>;
export declare function compactionRoute(plan: {
    chars: number;
    uncovered: string;
}): string;
export interface TextSplit {
    covered: string[];
    uncovered: string;
    codeLines: number;
}
export declare function planText(text: string): TextSplit;
export declare function hasProtectedToolFact(line: string): boolean;
export declare function unresolvedAssistantDecision(line: string): boolean;
export interface AttributedLine {
    sourceId?: number;
    role: string;
    line: string;
}
export declare function attributedLines(text: string, spans: CardSpan[] | null): AttributedLine[];
export declare function normalizeSourceLine(role: string, text: string): string;
interface CoverageLine {
    sourceId?: number;
    role?: string;
    line: string;
}
export declare function checkCoverage(opts: {
    sources: {
        id?: number;
        role: string;
    }[];
    requiredLines: CoverageLine[];
    keptLines: {
        sourceId?: number;
        text: string;
    }[];
}): {
    ok: boolean;
    keptLines: {
        sourceId?: number;
        text: string;
    }[];
    missing: {
        sourceId?: number;
        text: string;
        reason: string;
    }[];
};
export declare function hardItems(text: string, spans?: CardSpan[] | null): string[];
export declare function errorKeptLines(text: string): string[];
export declare function failureKeptLines(text: string): string[];
export declare function unknownKeptLines(text: string): string[];
export declare function isToolFailure(text: string, isError?: boolean): boolean;
export declare function exitCodeOf(text: string): number | null;
export declare function parseToolArguments(raw: unknown): Record<string, unknown>;
export declare function callCommand(name: string, raw: unknown): string;
export declare function callFilePath(raw: unknown): string;
export declare function callJobId(raw: unknown): string;
export declare function backgroundJobId(text: string): string;
export declare function readResultLabel(name: string, filePath: string, turn: number | null | undefined): string;
export declare function toolEvidenceLine(span: CardSpan): string;
export declare function evidenceLines(spans: CardSpan[]): string[];
export declare function demoteEvidence(line: string, ids: Set<string>): string;
export declare function admitEvidence(lines: string[], ids: Set<string>): string[];
export interface RoundEvent {
    type: string;
    toolCalls: number;
    longRead?: boolean;
    checkpoint?: boolean;
}
export interface ToolRound {
    start: number;
    end: number;
}
export declare function finishedToolRounds(events: RoundEvent[]): ToolRound[];
export declare function roundHasLongRead(events: RoundEvent[], round: ToolRound): boolean;
export declare function keptToolRounds(events: RoundEvent[], limit?: number, afterIndex?: number): ToolRound[];
export declare function cutLongReadRound(items: CutItem[], start: number, end: number, options?: SelectCutOptions): CutPick | null;
export declare function reservedCutEnd(keepStart: number, first: number): number | null;
export declare function chooseKeptSpan(rounds: ToolRound[], spanTokens: (from: ToolRound, to: ToolRound) => number, budget: number): ToolRound | null;
export declare function hostOf(baseURL: string): string;
export declare function isLocalHost(host: string): boolean;
export interface ProviderModelListing {
    id?: string;
    model?: string;
    baseURL?: string;
    baseUrl?: string;
}
export interface ProviderListing {
    provider?: string;
    id?: string;
    defaultBaseURL?: string;
    baseURL?: string;
    models?: ProviderModelListing[];
}
export declare function lookupProviderURL(provider: string, listed: ProviderListing[], model?: string): string;
export declare function fallbackProviderURL(provider: string): string;
export interface EngineResolution {
    engine: string;
    source: string;
}
export declare function resolveEngine(input?: {
    provider?: string;
    baseURL?: string;
    env?: Record<string, string | undefined>;
}): EngineResolution;
export interface CutItem {
    type: string;
    tokens: number;
    checkpoint?: boolean;
    balancedBefore?: boolean;
    balancedAfter?: boolean;
    untrustedNotice?: boolean;
}
export interface CutPick {
    start: number;
    end: number;
    tokens: number;
    gain: number;
    pointerOnly?: boolean;
}
export declare function cutCrossesNewerCheckpoint(items: CutItem[], end: number): boolean;
export interface SelectCutOptions {
    engine?: string;
    chunkMin?: number;
    chunkMax?: number;
    pointerMax?: number;
    minStart?: number;
    maxEnd?: number | null;
    totalTokens?: number;
    drain?: boolean;
    urgentTokens?: number;
}
export declare function selectCutIndexes(items: CutItem[], opts?: SelectCutOptions): CutPick | null;
export declare function pointerSpanAllowed(items: CutItem[], start: number, end: number, engine?: string): boolean;
export declare function earlierUsers(spans: CardSpan[]): string;
export declare function pointerOnlyText(pieces: CardSpan[]): string;
interface JobLine {
    jobId: string;
    command: string;
    startTurn: number | null | undefined;
    toolCallId: string;
}
export declare function jobCardLines(jobs: JobLine[]): string[];
export declare function commandLine(command: string | undefined): string;
export declare function fitFailure(block: string, budget: number): string;
export interface ToolExcerpt {
    text: string;
    omitted: number;
    needsBackup: boolean;
    failureDiagnosticsComplete: boolean;
    incompleteFailures: {
        sourceId?: number;
        reason: string;
    }[];
    excerpts: {
        sourceId?: number;
        text: string;
    }[];
    stats: {
        sourceId?: number;
        hardLines: string[];
        omittedOrdinaryToolLines: number;
    }[];
}
export declare function toolExcerpt(spans: CardSpan[], backupId?: string): ToolExcerpt;
export interface Card {
    ok: boolean;
    failureDiagnosticsComplete: boolean;
    verdict: string;
    scope: string;
    hardLines: string[];
    hardFacts: {
        role: string;
        line: string;
    }[];
    missingFacts: {
        role: string;
        line: string;
    }[];
    hardCount: number;
    omittedHard: number;
    deferred: number;
    missing: string[];
    omittedOrdinaryToolLines: number;
    uncovered: string;
    keptChars: number;
    needsBackup: boolean;
    rawPaths: string[];
    text: string;
}
export declare function buildCard(spanText: string, liveText?: string, spans?: CardSpan[] | null): Card;
export {};
