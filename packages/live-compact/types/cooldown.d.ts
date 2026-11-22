// 由 vendored 算法经 tsc 宽松模式生成，随上游同步再生；实现文件禁止手改
/** Default cooldown window: 5 minutes. Named, not a magic number. */
export declare const DEFAULT_COOLDOWN_MS = 300000;
/**
 * Parse the cooldown window. 0 (or negative, or unparsable) = the time
 * window is off and only the identity rule applies.
 */
export declare function resolveCooldownMs(env?: Record<string, string | undefined>): number;
export interface OfficialCompaction {
    id: string;
    time: number;
}
/** The newest official compaction in a projected entry list, if any. */
export declare function latestOfficialCompaction(projected: any[]): OfficialCompaction | null;
/** True while the newest official compaction is younger than the window. */
export declare function inCooldownWindow(official: OfficialCompaction | null, windowMs: number, now?: number): boolean;
/**
 * Once-per-live-card tracker for the identity rule. The first observed
 * state — with or without a compaction in it — only primes the baseline:
 * a card already there is restored history and never yields a pass.
 * Afterwards, a compaction whose id differs from the primed/last-seen id
 * is live and yields exactly one pass; repeats of the same id do not.
 */
export declare function createOfficialCompactionTracker(): {
    observe(official: OfficialCompaction | null): boolean;
};
