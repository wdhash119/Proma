// 由 vendored 算法经 tsc 宽松模式生成，随上游同步再生；实现文件禁止手改
export interface RecallItem {
    id: string;
    label: string;
    text: string;
}
export declare const RECALL_INLINE_LIMIT = 24000;
export declare class RecallStore {
    private items;
    private sidecar;
    private dir;
    bind(sessionFile: string | undefined): void;
    put(item: RecallItem): void;
    get(id: string): RecallItem | undefined;
    list(limit?: number): RecallItem[];
    get size(): number;
    dump(item: RecallItem): string;
}
export declare function recallHint(items: RecallItem[]): string;
export declare function recallResult(store: RecallStore, ref: string, toFile?: boolean): {
    text: string;
    found: boolean;
};
