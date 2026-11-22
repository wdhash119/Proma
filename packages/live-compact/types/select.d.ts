// 由 vendored 算法经 tsc 宽松模式生成，随上游同步再生；实现文件禁止手改
import { type Card } from "./plan";
export declare const CHUNK_MAX: number;
export declare const CHUNK_MIN: number;
export declare const POINTER_TOKENS: number;
export declare const URGENT_TOKENS = 48000;
export declare const KEEP_ROUNDS: number;
export declare const KEEP_ROUND_TOKENS: number;
export interface CallInfo {
    id: string;
    name: string;
    command: string;
    filePath: string;
}
export interface SpanEntry {
    id: string;
    role: string;
    text: string;
    tokens: number;
    toolCalls: string[];
    toolResultFor: string | null;
    isError?: boolean;
    turn?: number | null;
    call?: CallInfo | null;
    backgroundStart?: boolean;
    seq: number;
}
export interface Chunk {
    start: number;
    end: number;
    tokens: number;
    after: number;
    keptTokens: number;
    card: Card;
    pointerOnly?: boolean;
}
export declare function isCardEntry(entry: SpanEntry): boolean;
export declare function isCheckpointEntry(entry: SpanEntry): boolean;
export interface SelectOptions {
    engine?: string;
    totalTokens?: number;
    drain?: boolean;
}
export declare function selectNewestChunk(entries: SpanEntry[], opts?: SelectOptions): Chunk | null;
